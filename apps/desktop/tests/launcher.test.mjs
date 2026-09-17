import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertPortAvailable, DEFAULT_PORT, ensureProfile, extractTokenUrl, loadDesktopConfig, parseArguments,
  redactLog, startDsh, writeAtomicJson } from "../launcher.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "oh-story-desktop-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function fixtureRuntime(path) {
  const runtimeDir = join(path, "runtime");
  const pluginDir = join(runtimeDir, "node_modules", "@oh-story", "dsh");
  await mkdir(pluginDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(testsDir, "..", "..", "..", "packages", "dsh-plugin", "package.json"), "utf8"));
  await writeAtomicJson(join(pluginDir, "package.json"), manifest);
  return runtimeDir;
}

async function freePort() {
  const server = createServer();
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const port = server.address().port;
  await new Promise((accept) => server.close(accept));
  return port;
}

test("first launch records a stable origin and preserves a user-selected port", async (t) => {
  const dir = await temporary(t);
  assert.deepEqual(await loadDesktopConfig(dir), { schemaVersion: 1, port: DEFAULT_PORT });
  await writeAtomicJson(join(dir, "desktop.json"), { schemaVersion: 1, port: 47832 });
  assert.equal((await loadDesktopConfig(dir)).port, 47832);
});

test("invalid desktop configuration is rejected without overwriting it", async (t) => {
  const dir = await temporary(t);
  for (const source of ["{", "null", "[]", '{"schemaVersion":2,"port":47831}', '{"schemaVersion":1,"port":0}', '{"schemaVersion":1,"port":"47831"}']) {
    await writeFile(join(dir, "desktop.json"), source);
    await assert.rejects(loadDesktopConfig(dir), /configuration/);
    assert.equal(await readFile(join(dir, "desktop.json"), "utf8"), source);
  }
});

test("an occupied port fails explicitly and leaves the existing server alone", async (t) => {
  const server = createServer();
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  t.after(() => new Promise((accept) => server.close(accept)));
  await assert.rejects(assertPortAvailable(server.address().port), /port.*unavailable/);
  assert.equal(server.listening, true);
});

test("profile initialization restores required bundles and preserves user configuration", async (t) => {
  const dir = await temporary(t);
  const runtimeDir = await fixtureRuntime(dir);
  const profile = await ensureProfile(dir, runtimeDir);
  const patch = "# User provider configuration\n[]\n";
  await writeFile(join(profile, "cordis.patch.yml"), patch);
  const manifest = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
  manifest.dsh.profile.bundles = ["user-bundle", "@oh-story/dsh"];
  manifest.dependencies = { "user-bundle": "1.0.0" };
  manifest.dsh.profile.patchReload = "startup";
  await writeAtomicJson(join(profile, "package.json"), manifest);
  await ensureProfile(dir, runtimeDir);
  const updated = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
  assert.deepEqual(updated.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@oh-story/dsh", "user-bundle"]);
  assert.deepEqual(updated.dependencies, manifest.dependencies);
  assert.equal(updated.dsh.profile.patchReload, "startup");
  assert.equal(await readFile(join(profile, "cordis.patch.yml"), "utf8"), patch);
  assert.equal(await realpath(join(profile, "node_modules", "@oh-story", "dsh")), await realpath(join(runtimeDir, "node_modules", "@oh-story", "dsh")));
});

test("runtime relocation refreshes only the managed plugin link", async (t) => {
  const dir = await temporary(t);
  const first = await fixtureRuntime(join(dir, "first"));
  const second = await fixtureRuntime(join(dir, "second"));
  const profile = await ensureProfile(dir, first);
  await ensureProfile(dir, second);
  assert.equal(await realpath(join(profile, "node_modules", "@oh-story", "dsh")), await realpath(join(second, "node_modules", "@oh-story", "dsh")));
});

test("launcher rejects unmanaged plugin folders without deleting them", async (t) => {
  const dir = await temporary(t);
  const runtimeDir = await fixtureRuntime(dir);
  const link = join(dir, "dsh", "profiles", "web", "node_modules", "@oh-story", "dsh");
  await mkdir(link, { recursive: true });
  await writeFile(join(link, "user.txt"), "keep");
  await assert.rejects(ensureProfile(dir, runtimeDir), /unmanaged directory/);
  assert.equal(await readFile(join(link, "user.txt"), "utf8"), "keep");
});

test("logs redact process tokens, API key fields, and inherited credentials", () => {
  const environment = { DEEPSEEK_API_KEY: "test-key-123456789" };
  const safe = redactLog('http://127.0.0.1:47831/?token=secret-token API_KEY="field-secret" Bearer fallback test-key-123456789 Authorization: Bearer auth-secret', environment);
  for (const secret of ["secret-token", "field-secret", "test-key-123456789", "auth-secret"]) assert.equal(safe.includes(secret), false);
});

test("readiness accepts only the owned loopback port", () => {
  assert.equal(extractTokenUrl("http://127.0.0.1:47832/?token=other", 47831), undefined);
  assert.equal(extractTokenUrl("http://attacker.example:47831/?token=other", 47831), undefined);
  assert.equal(extractTokenUrl("dsh web: http://127.0.0.1:47831/?token=abc.xyz-123\n", 47831), "http://127.0.0.1:47831/?token=abc.xyz-123");
});

test("argument parsing requires explicit absolute paths", () => {
  const dataDir = join(tmpdir(), "desktop-data");
  const statusFile = join(dataDir, "status.json");
  assert.deepEqual(parseArguments(["--data-dir", dataDir, "--status-file", statusFile]), { dataDir, statusFile });
  assert.throws(() => parseArguments(["--data-dir", "relative"]), /Usage/);
  assert.throws(() => parseArguments(["--data-dir", dataDir]), /required/);
  assert.throws(() => parseArguments(["--port", "47831"]), /Usage/);
});

test("owned child authenticates, redacts split token logs, and shuts down gracefully", async (t) => {
  const dir = await temporary(t);
  const runtimeDir = await fixtureRuntime(dir);
  const port = await freePort();
  await writeAtomicJson(join(dir, "desktop.json"), { schemaVersion: 1, port });
  const statusFile = join(dir, "startup.json");
  const runtime = await startDsh({ dataDir: dir, statusFile, runtimeDir, dshBin: join(testsDir, "fixtures", "mock-dsh.mjs"), startupTimeoutMs: 10_000 });
  t.after(() => runtime.stop());
  assert.equal(await runtime.ready, `http://127.0.0.1:${port}/?token=mock-desktop-process-token`);
  assert.equal(JSON.parse(await readFile(statusFile, "utf8")).state, "ready");
  await writeFile(`${statusFile}.shutdown`, "shutdown\n");
  assert.equal((await runtime.exited).code, 0);
  const log = await readFile(join(dir, "logs", "desktop.log"), "utf8");
  assert.equal(log.includes("mock-desktop-process-token"), false);
  assert.equal(log.includes("[redacted]"), true);
  await assertPortAvailable(port);
});

test("a child failure produces an actionable status and terminates", async (t) => {
  const dir = await temporary(t);
  const runtimeDir = await fixtureRuntime(dir);
  await writeAtomicJson(join(dir, "desktop.json"), { schemaVersion: 1, port: await freePort() });
  const statusFile = join(dir, "startup.json");
  const broken = join(dir, "broken.mjs");
  await writeFile(broken, 'process.stderr.write("Deliberate startup failure\\n"); process.exit(3);\n');
  const runtime = await startDsh({ dataDir: dir, statusFile, runtimeDir, dshBin: broken, startupTimeoutMs: 5_000 });
  await assert.rejects(runtime.ready, /Deliberate startup failure/);
  await runtime.exited;
  const result = JSON.parse(await readFile(statusFile, "utf8"));
  assert.equal(result.state, "error");
  assert.match(result.message, /Deliberate startup failure/);
});
