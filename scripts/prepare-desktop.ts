import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { generateDesktopIcons } from "./desktop-icons.js";

const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "apps", "desktop");
const runtime = join(desktop, "runtime");
const dependencies = join(desktop, "runtime-deps");
const plugin = join(root, "packages", "dsh-plugin");

function hash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function removeGeneratedDirectory(path: string): Promise<void> {
  const resolved = resolve(path);
  const canonical = await realpath(path).catch(() => resolved);
  if (!resolved.startsWith(`${runtime}${sep}`) || !canonical.startsWith(`${await realpath(runtime)}${sep}`)) {
    throw new Error(`Refusing to remove a directory outside generated desktop runtime: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

function installRuntime(): void {
  const args = ["--dir", dependencies, "install", "--frozen-lockfile", "--prefer-offline"];
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error("Run preparation through pnpm desktop:prepare.");
  const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` };
  const result = spawnSync(process.execPath, [pnpm, ...args], { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Desktop dependency installation failed: ${result.error?.message ?? result.status}`);
}

async function prepare(): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Desktop packaging currently targets Windows x64.");
  const node = resolve(process.env.OH_STORY_DESKTOP_NODE ?? process.execPath);
  const nodeVersion = spawnSync(node, ["--eval", "process.stdout.write(JSON.stringify({version:process.version,arch:process.arch,platform:process.platform}))"], { encoding: "utf8", windowsHide: true });
  const details = nodeVersion.status === 0 ? JSON.parse(nodeVersion.stdout) as { version?: string; arch?: string; platform?: string } : {};
  const version = details.version;
  if (!/^v24\./u.test(version ?? "") || details.arch !== "x64" || details.platform !== "win32") throw new Error("Desktop runtime requires Windows x64 Node.js 24. Run pnpm with Node 24 or set OH_STORY_DESKTOP_NODE to that executable.");
  await mkdir(runtime, { recursive: true });
  installRuntime();
  const lockHash = hash(await readFile(join(dependencies, "pnpm-lock.yaml")));
  const priorHash = await readFile(join(runtime, ".dependency-fingerprint"), "utf8").catch(() => "");
  const currentDsh = join(runtime, "node_modules", "@deepseek-ai", "dsh", "package.json");
  const installed = await readFile(currentDsh, "utf8").then(() => true, () => false);
  if (priorHash !== lockHash || !installed) {
    await removeGeneratedDirectory(join(runtime, "node_modules"));
    await cp(join(dependencies, "node_modules"), join(runtime, "node_modules"), { recursive: true, dereference: true });
    await writeFile(join(runtime, ".dependency-fingerprint"), lockHash);
  }
  await cp(node, join(runtime, "node.exe"));
  await cp(join(dependencies, "package.json"), join(runtime, "package.json"));
  await cp(join(desktop, "launcher.mjs"), join(runtime, "launcher.mjs"));
  const bundledPlugin = join(runtime, "node_modules", "@oh-story", "dsh");
  await removeGeneratedDirectory(bundledPlugin);
  await mkdir(bundledPlugin, { recursive: true });
  for (const file of ["lib", "package.json", "cordis.patch.yml", "LICENSE", "README.md"]) {
    await cp(join(plugin, file), join(bundledPlugin, file), { recursive: true });
  }
  // Keep the runtime license beside the executable when copying a standalone Node binary.
  const licensePath = join(runtime, "NODE-LICENSE.txt");
  const priorVersion = await readFile(join(runtime, "manifest.json"), "utf8")
    .then(text => (JSON.parse(text) as { nodeVersion?: string }).nodeVersion, () => undefined);
  const hasLicense = await readFile(licensePath, "utf8").then(text => text.includes("Node.js"), () => false);
  if (priorVersion !== version || !hasLicense) {
    const providedLicense = process.env.OH_STORY_DESKTOP_NODE_LICENSE;
    if (providedLicense) await cp(providedLicense, licensePath);
    else {
      const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Could not obtain Node license (${response.status}); set OH_STORY_DESKTOP_NODE_LICENSE to its local LICENSE file.`);
      const license = await response.text();
      if (!license.includes("Node.js")) throw new Error("Unexpected Node license content.");
      await writeFile(licensePath, license);
    }
  }
  const pluginPackage = JSON.parse(await readFile(join(plugin, "package.json"), "utf8")) as { version: string };
  const dshPackage = JSON.parse(await readFile(currentDsh, "utf8")) as { version: string };
  const manifest = {
    schemaVersion: 1,
    platform: "win32-x64",
    nodeVersion: version,
    nodeSha256: hash(await readFile(node)),
    dshVersion: dshPackage.version,
    pluginVersion: pluginPackage.version,
    dependencyLockSha256: lockHash,
    pluginHostSha256: hash(await readFile(join(bundledPlugin, "lib", "index.js"))),
    pluginClientSha256: hash(await readFile(join(bundledPlugin, "lib", "client.js")))
  };
  await writeFile(join(runtime, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(root, "LICENSE"), join(runtime, "OH-STORY-LICENSE.txt"));
  await generateDesktopIcons();
  console.log(`Desktop runtime prepared: Node ${version}, DSH ${dshPackage.version}, Oh Story ${pluginPackage.version}.`);
}

await prepare();
