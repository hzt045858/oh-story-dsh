import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { renderSkillContent } from "@deepseek-ai/dsh-skill";
import { describe, expect, it } from "vitest";
import { hostPython } from "../src/host-python.js";
import { createWechatSkillProvider } from "../src/skill-provider.js";

const root = resolve(import.meta.dirname, "../../knowledge/wechat/skills");
const execFileAsync = promisify(execFile);

describe("native WeChat article Skill", () => {
  it("enforces universal task control independently of account style, form, provider and source availability", async () => {
    const python = await hostPython();
    expect(python.probe.ok).toBe(true);
    for (const script of ["controlled_selftest.py", "style_release_selftest.py"]) {
      const result = await execFileAsync(python.command, ["-B", resolve(root, "wechat-article/scripts", script)], {
        env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", timeout: 45_000
      });
      expect(result.stderr).toMatch(/\bOK\b/u);
    }
  }, 60_000);
  it("requires whole-article joint evidence and imports supplied images without inventing generation", async () => {
    const python = await hostPython();
    expect(python.probe.ok).toBe(true);
    for (const script of ["joint_selftest.py", "import_image_selftest.py"]) {
      const result = await execFileAsync(python.command, ["-B", resolve(root, "wechat-article/scripts", script)], {
        env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
        encoding: "utf8",
        timeout: 30_000
      });
      expect(result.stderr).toMatch(/\bOK\b/u);
    }
  }, 30_000);
  it("is discoverable with a resource base that resolves all local references", async () => {
    const provider = createWechatSkillProvider(root);
    const candidates = await provider.list({});
    if (!Array.isArray(candidates)) throw new Error("Expected a bundled catalog");
    expect(candidates.map((candidate) => candidate.name)).toEqual(["wechat-article"]);
    const skill = await provider.get(candidates[0]!, {});
    expect(skill?.invocation).toEqual({ userInvocable: true, modelInvocable: true });
    expect(skill?.resourceBase).toEqual({ kind: "directory", path: resolve(root, "wechat-article") });
    expect(renderSkillContent(skill!)).toContain(resolve(root, "wechat-article"));
    expect(renderSkillContent(skill!)).toContain("article_workflow.py");
    expect(renderSkillContent(skill!)).toContain("workflow-control.md");
    const skillDirectory = resolve(root, "wechat-article");
    const references = await readdir(resolve(skillDirectory, "references"));
    for (const path of [resolve(skillDirectory, "SKILL.md"), ...references.map((name) => resolve(skillDirectory, "references", name))]) {
      const content = await readFile(path, "utf8");
      for (const match of content.matchAll(/\]\(([^)]+)\)/gu)) {
        const target = match[1]!;
        if (/^https?:/u.test(target)) continue;
        expect((await stat(resolve(dirname(path), target))).isFile(), `${path}: ${target}`).toBe(true);
      }
    }
  });

  it("exercises source preservation, full-text retrieval, and image dispatch receipts offline", async () => {
    const python = await hostPython();
    expect(python.probe.ok).toBe(true);
    const result = await execFileAsync(python.command, ["-B", resolve(root, "wechat-article/scripts/selftest.py")], {
      env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
      timeout: 30_000
    });
    expect(result.stderr).toMatch(/\bOK\b/u);
  });

  it("runs the multi-account draft and publication workflow against an isolated fake API", async () => {
    const python = await hostPython();
    expect(python.probe.ok).toBe(true);
    const result = await execFileAsync(python.command, ["-B", resolve(root, "wechat-article/scripts/publish_selftest.py")], {
      env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
      timeout: 30_000
    });
    expect(result.stderr).toMatch(/\bOK\b/u);
  }, 30_000);

  it("prepares ordered image bodies without treating OCR as reviewed content", async () => {
    const python = await hostPython();
    expect(python.probe.ok).toBe(true);
    const result = await execFileAsync(python.command, ["-B", resolve(root, "wechat-article/scripts/ingest_selftest.py")], {
      env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
      timeout: 30_000
    });
    expect(result.stderr).toMatch(/\bOK\b/u);
  }, 30_000);
});
