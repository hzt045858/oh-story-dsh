import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

export const DEFAULT_PORT = 47831;
const launcherFile = fileURLToPath(import.meta.url);
const requiredBundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@oh-story/dsh"];

export async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadDesktopConfig(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "desktop.json");
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read desktop configuration: ${path}. Correct the JSON file and restart.`, { cause: error });
    config = { schemaVersion: 1, port: DEFAULT_PORT };
    await writeAtomicJson(path, config);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)
    || config.schemaVersion !== 1 || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error(`Invalid desktop configuration: ${path}. Expected schemaVersion 1 and a port between 1024 and 65535.`);
  }
  return config;
}

export async function assertPortAvailable(port) {
  const server = createServer();
  try {
    await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen({ port, host: "127.0.0.1", exclusive: true }, accept);
    });
  } catch (error) {
    throw new Error(`Local port ${port} is unavailable. Close the application using this port and retry. The desktop port stays fixed to preserve draft storage.`, { cause: error });
  } finally {
    if (server.listening) await new Promise((accept) => server.close(accept));
  }
}

export async function ensureProfile(dataDir, runtimeDir) {
  const profileDir = join(dataDir, "dsh", "profiles", "web");
  const manifestPath = join(profileDir, "package.json");
  const pluginDir = join(runtimeDir, "node_modules", "@oh-story", "dsh");
  const pluginManifest = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
  if (pluginManifest.name !== "@oh-story/dsh" || !["cordis.patch.yml", "./cordis.patch.yml"].includes(pluginManifest.dsh?.bundle?.patch)) {
    throw new Error("The bundled Oh Story plugin is missing or invalid. Rebuild or reinstall the desktop application.");
  }
  await mkdir(profileDir, { recursive: true });
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
      || !Array.isArray(manifest.dsh?.profile?.bundles)
      || !manifest.dsh.profile.bundles.every((name) => typeof name === "string")) throw new Error("Invalid profile manifest");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read DSH profile: ${manifestPath}. Correct the JSON file and restart.`, { cause: error });
    manifest = { name: "oh-story-desktop-profile", private: true, dependencies: {}, dsh: { profile: { bundles: [], patchReload: "live" } } };
  }
  const previousBundles = manifest.dsh.profile.bundles;
  const bundles = [...requiredBundles, ...previousBundles.filter((name) => !requiredBundles.includes(name))];
  if (!existsSync(manifestPath) || JSON.stringify(previousBundles) !== JSON.stringify(bundles)) {
    manifest.dsh.profile.bundles = bundles;
    await writeAtomicJson(manifestPath, manifest);
  }
  try { await writeFile(join(profileDir, "cordis.patch.yml"), "[]\n", { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }

  // DSH links its dependency closure, but an external bundle needs its own import entry.
  const link = join(profileDir, "node_modules", "@oh-story", "dsh");
  await mkdir(dirname(link), { recursive: true });
  let existing;
  try { existing = await lstat(link); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) throw new Error(`The desktop plugin path is occupied by an unmanaged directory: ${link}. Move it aside and restart.`);
    let target;
    try { target = await realpath(link); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (target === await realpath(pluginDir)) return profileDir;
    await unlink(link);
  }
  await symlink(pluginDir, link, process.platform === "win32" ? "junction" : "dir");
  return profileDir;
}

export function redactLog(text, environment = process.env) {
  let safe = text.replace(/([?&]token=)[^\s"'<>]+/giu, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/giu, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*["']?\s*[:=]\s*["']?)[^\s,"';]+/giu, "$1[redacted]");
  for (const [name, value] of Object.entries(environment)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/iu.test(name) && typeof value === "string" && value.length >= 8) safe = safe.replaceAll(value, "[redacted]");
  }
  return safe;
}

export function extractTokenUrl(text, port) {
  const matches = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_.-]+/gu) ?? [];
  return matches.find((candidate) => new URL(candidate).origin === `http://127.0.0.1:${port}`);
}

async function createLogger(dataDir, environment) {
  const path = join(dataDir, "logs", "desktop.log");
  await mkdir(dirname(path), { recursive: true });
  try {
    if ((await stat(path)).size > 5 * 1024 * 1024) {
      await rm(`${path}.previous`, { force: true });
      await rename(path, `${path}.previous`);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return (message) => appendFileSync(path, `${new Date().toISOString()} ${redactLog(message, environment)}\n`, { mode: 0o600 });
}

export async function startDsh({ dataDir, statusFile, runtimeDir = dirname(launcherFile), nodeExecutable = process.execPath,
  dshBin = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), startupTimeoutMs = 110_000,
  environment = process.env }) {
  const config = await loadDesktopConfig(dataDir);
  await assertPortAvailable(config.port);
  await ensureProfile(dataDir, runtimeDir);
  if (!existsSync(dshBin)) throw new Error("The bundled DSH runtime is missing. Rebuild or reinstall the desktop application.");
  const workspaces = join(dataDir, "workspaces");
  await mkdir(workspaces, { recursive: true });
  const env = { ...environment, DSH_HOME: join(dataDir, "dsh"), DSH_TELEMETRY_DISABLED: "1", OH_STORY_DESKTOP_DSH_CHILD: "1" };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${dirname(nodeExecutable)}${delimiter}${env[pathKey] ?? ""}`;
  const log = await createLogger(dataDir, env);
  log(`Starting DSH on 127.0.0.1:${config.port}.`);
  const child = spawn(nodeExecutable, ["--import", pathToFileURL(launcherFile).href, dshBin,
    "web", "--host", "127.0.0.1", "--no-open", "--port", String(config.port)], {
    cwd: workspaces, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let stopping = false;
  let readySettled = false;
  let authorizing = false;
  let tokenUrl;
  let recentError = "";
  let resolveReady;
  let rejectReady;
  let resolveExited;
  const ready = new Promise((accept, reject) => { resolveReady = accept; rejectReady = reject; });
  const exited = new Promise((accept) => { resolveExited = accept; });
  const deadline = setTimeout(() => {
    fail(new Error("DSH startup timed out. See logs/desktop.log in the application data directory."));
    void stop();
  }, startupTimeoutMs);
  let statusWrite = Promise.resolve();
  function fail(error) {
    const message = redactLog(error.message, env);
    log(message);
    statusWrite = statusWrite.then(() => writeAtomicJson(statusFile, { state: "error", message }));
    if (!readySettled) {
      readySettled = true;
      clearTimeout(deadline);
      rejectReady(new Error(message));
    }
  }
  async function authorize() {
    if (authorizing || readySettled || tokenUrl === undefined || stopping) return;
    authorizing = true;
    try {
      const response = await globalThis.fetch(tokenUrl, { redirect: "manual", signal: globalThis.AbortSignal.timeout(3_000) });
      if (response.status >= 200 && response.status < 400 && response.headers.get("set-cookie") !== null
        && child.exitCode === null && child.signalCode === null && !stopping && !readySettled) {
        statusWrite = statusWrite.then(async () => {
          if (stopping || readySettled || child.exitCode !== null || child.signalCode !== null) return;
          await writeAtomicJson(statusFile, { state: "ready", url: tokenUrl });
          if (stopping || readySettled || child.exitCode !== null || child.signalCode !== null) return;
          readySettled = true;
          clearTimeout(deadline);
          log("DSH is ready.");
          resolveReady(tokenUrl);
        });
        await statusWrite;
      }
    } catch { /* The HTTP route may still be registering after the listener starts. */ }
    finally { authorizing = false; }
  }
  for (const [stream, label] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        log(`[${label}] ${line}`);
        if (label === "stderr") recentError = redactLog(line, env).slice(-1_000);
        tokenUrl ??= extractTokenUrl(line, config.port);
      }
      // Never persist a split line: a credential may straddle pipe chunks.
      if (pending.length > 128 * 1024) pending = "[oversized log line omitted]";
      void authorize();
    });
    stream.on("end", () => {
      if (pending !== "") log(`[${label}] ${pending}`);
    });
  }
  const retry = setInterval(() => {
    if (existsSync(`${statusFile}.shutdown`)) void stop();
    else void authorize();
  }, 200);
  child.once("error", (error) => {
    recentError = redactLog(error.message, env);
    fail(error);
  });
  child.once("close", (code, signal) => {
    clearTimeout(deadline);
    clearInterval(retry);
    if (!stopping) fail(new Error(`DSH stopped unexpectedly (${signal ?? code ?? "unknown"}). ${recentError || "See logs/desktop.log for details."}`));
    else if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("Desktop startup was stopped."));
    }
    statusWrite.then(() => resolveExited({ code, signal }), () => resolveExited({ code, signal }));
  });
  async function stop() {
    if (stopping) return exited;
    stopping = true;
    clearTimeout(deadline);
    clearInterval(retry);
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    log("Stopping DSH.");
    if (child.connected) child.send({ type: "oh-story-desktop-shutdown" }, () => {});
    else child.kill("SIGTERM");
    const force = setTimeout(() => { child.kill("SIGKILL"); }, 6_000);
    await exited;
    clearTimeout(force);
    await rm(`${statusFile}.shutdown`, { force: true });
    return exited;
  }
  return { ready, exited, stop, child };
}

export function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--data-dir", "--status-file"].includes(key) || typeof value !== "string" || !isAbsolute(value)
      || values[key] !== undefined) throw new Error("Usage: launcher.mjs --data-dir <absolute directory> --status-file <absolute file>");
    values[key] = value;
  }
  if (values["--data-dir"] === undefined || values["--status-file"] === undefined) throw new Error("Both --data-dir and --status-file are required.");
  return { dataDir: values["--data-dir"], statusFile: values["--status-file"] };
}

// Preloaded into the owned DSH child: IPC requests use DSH's existing bounded disposer on Windows.
if (process.env.OH_STORY_DESKTOP_DSH_CHILD === "1" && typeof process.send === "function") {
  process.once("message", (message) => {
    if (message?.type === "oh-story-desktop-shutdown") process.emit("SIGTERM");
  });
  process.once("disconnect", () => process.emit("SIGTERM"));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === launcherFile) {
  let options;
  let runtime;
  try {
    options = parseArguments(process.argv.slice(2));
    runtime = await startDsh(options);
    process.once("SIGINT", () => { void runtime.stop(); });
    process.once("SIGTERM", () => { void runtime.stop(); });
    await runtime.ready;
    await runtime.exited;
  } catch (error) {
    if (options !== undefined) await writeAtomicJson(options.statusFile, { state: "error", message: redactLog(error.message) });
    if (runtime !== undefined) await runtime.stop();
    process.exitCode = 1;
  }
}
