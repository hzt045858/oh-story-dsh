import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../runtime-deps/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js", import.meta.url), "utf8");

function snapshotStore(initial) {
  let value = globalThis.structuredClone(initial);
  const subscribers = new Set();
  const store = {
    getSnapshot: () => value,
    set(next) {
      value = globalThis.structuredClone(next);
      for (const callback of subscribers) callback();
    },
    update(edit) {
      const draft = globalThis.structuredClone(value);
      edit(draft);
      store.set(draft);
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  };
  return store;
}

let ModelDirectory;
runInNewContext(source, {
  window: {
    __ModuleLoader__: {
      load(definition) {
        ({ ModelDirectory } = definition.factory((id) => {
          if (id === "@deepseek-ai/cordis") return { Service: class {} };
          if (id === "@deepseek-ai/dsh-client-store") return { createSnapshotStore: snapshotStore };
          return {};
        }));
      },
    },
  },
});

const selection = (reasoningEffort, model = "test-model") => ({
  provider: "test-provider",
  model,
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
});

function fixture({ levels = ["high", "max"], available = true, catalogStatus = "ready", listed = true } = {}) {
  const requests = [];
  const responses = [];
  const catalog = {
    store: snapshotStore({
      status: catalogStatus,
      error: catalogStatus === "error" ? "catalog failed" : null,
      value: {
        default: selection(),
        routableProviders: ["test-provider"],
        groups: listed ? [{
          id: "test-provider",
          models: [{ id: "test-model", ...(levels === null ? {} : { reasoning: { efforts: levels.map((id) => ({ id })) } }) },
            { id: "other-model", reasoning: { efforts: [{ id: "high" }] } }],
        }] : [],
        failures: listed ? [] : [{ id: "test-provider", message: "unavailable" }],
      },
    }),
    load: async () => catalog.store.getSnapshot().value,
  };
  const projected = snapshotStore({ next: selection("max") });
  const directory = new ModelDirectory({
    selectModel(request) {
      requests.push({ ...request });
      return new Promise((resolve, reject) => responses.push({ resolve, reject }));
    },
  }, "session-test", () => available, catalog, projected);
  return {
    directory,
    requests,
    responses,
    publish: (next) => projected.set({ next }),
    refresh: () => catalog.store.set(catalog.store.getSnapshot()),
    disable() {
      catalog.store.update((state) => { delete state.value.groups[0].models[0].reasoning; });
    },
    finish(index, selected) {
      responses[index].resolve({ ok: true, value: { selected } });
    },
  };
}

test("disabled reasoning clears the durable effort when projection precedes the RPC response", async () => {
  const f = fixture();
  f.disable();
  assert.deepEqual(f.requests, [{ sessionId: "session-test", ...selection() }]);
  assert.equal(f.directory.store.getSnapshot().routable, false);
  f.publish(selection());
  assert.equal(f.directory.store.getSnapshot().routable, true);
  f.refresh();
  assert.equal(f.directory.store.getSnapshot().status, "selecting");
  f.finish(0, selection());
  await settle();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.directory.store.getSnapshot().current, selection());
  assert.equal(f.directory.store.getSnapshot().status, "ready");
  f.directory.dispose();
});

test("a delayed durable projection does not repeatedly clear an unsupported effort", async () => {
  const f = fixture({ levels: ["high"] });
  f.finish(0, selection("high"));
  await settle();
  f.refresh();
  f.refresh();
  assert.equal(f.requests.length, 1);
  assert.equal(f.directory.store.getSnapshot().routable, false);
  f.publish(selection("high"));
  assert.equal(f.directory.store.getSnapshot().routable, true);
  assert.deepEqual(f.directory.store.getSnapshot().current, selection("high"));
  f.directory.dispose();
});

test("capability changes cannot overwrite an in-flight manual selection or its delayed projection", async () => {
  const f = fixture();
  const manual = f.directory.select(selection("high", "other-model"));
  f.disable();
  f.refresh();
  assert.equal(f.requests.length, 1);
  f.finish(0, selection("high", "other-model"));
  await manual;
  f.refresh();
  assert.equal(f.requests.length, 1);
  f.publish(selection("high", "other-model"));
  assert.deepEqual(f.directory.store.getSnapshot().current, selection("high", "other-model"));
  f.directory.dispose();
});

test("unlisted models, failed catalogs and unavailable sessions never trigger a correction", () => {
  for (const options of [{ listed: false }, { catalogStatus: "error", levels: null }, { available: false, levels: null }]) {
    const f = fixture(options);
    f.refresh();
    assert.equal(f.requests.length, 0);
    f.directory.dispose();
  }
});

test("a rejected automatic correction surfaces its error without retrying on every refresh", async () => {
  const f = fixture({ levels: null });
  f.responses[0].resolve({ ok: false, error: { code: "unavailable", message: "temporary failure" } });
  await settle();
  f.refresh();
  f.refresh();
  assert.equal(f.requests.length, 1);
  assert.equal(f.directory.store.getSnapshot().status, "error");
  assert.match(f.directory.store.getSnapshot().error, /temporary failure/);
  f.directory.resetConnected();
  assert.equal(f.requests.length, 2);
  f.publish(selection());
  f.finish(1, selection());
  await settle();
  assert.equal(f.directory.store.getSnapshot().status, "ready");
  f.directory.dispose();
});

test("explicit retry reattempts a failed correction once without refresh loops", async () => {
  const f = fixture({ levels: null });
  f.responses[0].resolve({ ok: false, error: { code: "unavailable", message: "temporary failure" } });
  await settle();
  f.refresh();
  assert.equal(f.requests.length, 1);
  await f.directory.load();
  f.refresh();
  assert.equal(f.requests.length, 2);
  f.publish(selection());
  f.finish(1, selection());
  await settle();
  assert.equal(f.directory.store.getSnapshot().status, "ready");
  f.directory.dispose();
});

test("transport failure ends a correction's pending state and leaves manual recovery available", async () => {
  const f = fixture({ levels: null });
  f.responses[0].reject(new Error("connection lost"));
  await settle();
  f.refresh();
  assert.equal(f.directory.store.getSnapshot().status, "error");
  assert.equal(f.requests.length, 1);
  const manual = f.directory.select(selection());
  f.publish(selection());
  f.finish(1, selection());
  await manual;
  assert.equal(f.directory.store.getSnapshot().status, "ready");
  f.directory.dispose();
});

test("a newer manual selection wins over an older correction response", async () => {
  const f = fixture({ levels: null });
  const manual = f.directory.select(selection("high", "other-model"));
  f.finish(0, selection());
  await settle();
  f.publish(selection());
  f.refresh();
  assert.equal(f.directory.store.getSnapshot().status, "selecting");
  assert.equal(f.requests.length, 2);
  f.finish(1, selection("high", "other-model"));
  await manual;
  f.publish(selection("high", "other-model"));
  assert.deepEqual(f.directory.store.getSnapshot().current, selection("high", "other-model"));
  f.directory.dispose();
});
