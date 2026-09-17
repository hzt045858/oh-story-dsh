import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../runtime-deps/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js", import.meta.url), "utf8");

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

const warnings = [];
let apply;
runInNewContext(source, {
  console: { warn: (...args) => warnings.push(args) },
  window: {
    __ModuleLoader__: {
      load(definition) {
        ({ apply } = definition.factory((id) => {
          if (id === "@deepseek-ai/cordis") return {
            Service: class {
              constructor(ctx, name) { ctx[name] = this; }
            },
          };
          if (id === "@deepseek-ai/dsh-client-store") return { createSnapshotStore: snapshotStore };
          return {};
        }));
      },
    },
  },
});

function fixture({ current = "existing-blank", empty = false, phase = "ready" } = {}) {
  const requests = [];
  const responses = [];
  const opened = [];
  const disposers = [];
  const workspace = { workspaceId: "workspace-test", path: "C:/story", sessionIds: ["existing-blank"], createdAt: "2026-09-10T00:00:00Z" };
  const workspaces = {
    list: snapshotStore({ phase, items: empty ? [] : [workspace], archivedSessionIds: [] }),
  };
  const sessions = {
    list: snapshotStore({
      phase,
      current: empty || current === null ? undefined : current,
      ids: empty ? [] : ["existing-blank"],
      byId: empty ? {} : { "existing-blank": { id: "existing-blank", blank: true, cwd: workspace.path, updatedAt: 1 } },
    }),
    create(request) {
      requests.push({ ...request });
      return new Promise((resolve, reject) => responses.push({ resolve, reject }));
    },
    open(id) {
      opened.push(id);
      sessions.list.update((state) => { state.current = id; });
    },
    clear() {
      sessions.list.update((state) => { delete state.current; });
    },
  };
  const ctx = {
    get: (name) => ({ sessions, workspaces })[name],
    remote: { directoryPicker: {} },
    locale: { register: () => () => {} },
    slots: { provideRoot() {}, inject() {} },
    effect(callback) { disposers.push(callback()); },
  };
  apply(ctx);
  return {
    ui: ctx.uiWorkspace,
    workspaces,
    sessions,
    requests,
    responses,
    opened,
    finish(index, id) {
      workspaces.list.update((state) => { state.items[0].sessionIds.push(id); });
      sessions.list.update((state) => {
        state.ids.push(id);
        state.byId[id] = { id, blank: true, cwd: workspace.path, updatedAt: index + 2 };
      });
      responses[index].resolve(id);
    },
    dispose() { for (const dispose of disposers) dispose?.(); },
  };
}

test("explicit New Session creates and opens a fresh session even when the current session is blank", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  f.ui.startSession();
  assert.deepEqual(f.requests, [{ workspaceId: "workspace-test" }]);
  assert.equal(f.sessions.list.getSnapshot().current, "existing-blank");
  f.finish(0, "fresh-1");
  await settle();
  assert.equal(f.sessions.list.getSnapshot().current, "fresh-1");
  assert.deepEqual(f.opened, ["fresh-1"]);
  assert.deepEqual(f.sessions.list.getSnapshot().ids, ["existing-blank", "fresh-1"]);
});

test("passive workspace connection reuses an attached empty session", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  assert.equal(await f.ui.connectWorkspace("workspace-test"), "existing-blank");
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.opened, []);
});

test("initial navigation waits for loaded stores and restores an empty session without creating one", async (t) => {
  const f = fixture({ current: null, phase: "loading" });
  t.after(() => f.dispose());
  f.workspaces.list.update((state) => { state.phase = "ready"; });
  assert.deepEqual(f.opened, []);
  f.sessions.list.update((state) => { state.phase = "ready"; });
  await settle();
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.opened, ["existing-blank"]);
  f.sessions.list.set(f.sessions.list.getSnapshot());
  f.workspaces.list.set(f.workspaces.list.getSnapshot());
  await settle();
  assert.deepEqual(f.opened, ["existing-blank"]);
});

test("repeated explicit clicks share an in-flight creation but a later click creates another session", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  f.ui.startSession();
  f.ui.startSession("workspace-test");
  await settle();
  assert.equal(f.requests.length, 1);
  f.finish(0, "fresh-1");
  await settle();
  assert.equal(f.sessions.list.getSnapshot().current, "fresh-1");
  f.ui.startSession();
  assert.equal(f.requests.length, 2);
  f.finish(1, "fresh-2");
  await settle();
  assert.equal(f.sessions.list.getSnapshot().current, "fresh-2");
});

test("a failed explicit creation preserves the current session and releases the retry guard", async (t) => {
  const f = fixture();
  t.after(() => f.dispose());
  const previousWarnings = warnings.length;
  f.ui.startSession();
  f.responses[0].reject(new Error("temporary creation failure"));
  await settle();
  assert.equal(f.sessions.list.getSnapshot().current, "existing-blank");
  assert.equal(warnings.length, previousWarnings + 1);
  f.ui.startSession();
  assert.equal(f.requests.length, 2);
  f.finish(1, "retried-session");
  await settle();
  assert.equal(f.sessions.list.getSnapshot().current, "retried-session");
});

test("New Session without a workspace requests the directory flow without creating a session", async (t) => {
  const f = fixture({ empty: true });
  t.after(() => f.dispose());
  assert.equal(f.ui.workspacePickerRequest.getSnapshot(), false);
  f.ui.startSession();
  f.ui.startSession();
  await settle();
  assert.equal(f.ui.workspacePickerRequest.getSnapshot(), true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.sessions.list.getSnapshot().current, undefined);
});
