import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../packages/knowledge/wechat");
const manifestPath = resolve(root, "upstreams.json");
interface ReferenceFile { source: string; target: string; sha256?: string }
interface Source { id: string; repository: string; revision: string; files: ReferenceFile[] }
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { sources: Source[] };
const check = process.argv.includes("--check");
let count = 0;
for (const source of manifest.sources) {
  for (const file of source.files) {
    const target = resolve(root, "third_party", source.id, file.target);
    let content: Buffer;
    if (check) {
      content = await readFile(target);
    } else {
      const response = await fetch(`https://api.github.com/repos/${source.repository}/contents/${file.source}?ref=${source.revision}`, {
        headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${source.repository}/${file.source}`);
      const blob = await response.json() as { encoding: string; content: string };
      if (blob.encoding !== "base64") throw new Error("Expected a GitHub base64 blob");
      content = Buffer.from(blob.content, "base64");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const sha = createHash("sha256").update(content).digest("hex");
    if (check && file.sha256 !== sha) throw new Error(`Bundled reference changed: ${source.id}/${file.target}`);
    file.sha256 = sha;
    count++;
  }
}
if (!check) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(`WeChat references ${check ? "verified" : "synced"}: ${count} pinned files, ${manifest.sources.length} registered projects.\n`);
