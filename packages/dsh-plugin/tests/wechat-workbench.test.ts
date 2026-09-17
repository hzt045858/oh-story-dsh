import { describe, expect, it } from "vitest";
import { creativeRelativePath, preferredWorkbenchFile, workbenchModeForPath } from "../src/client/file-activity.js";
import { readDraftBackup, writeDraftBackup } from "../src/client/draft-backup.js";
import { isWechatReferencePath, wechatImagePath } from "../src/wechat-files.js";
import { assertCreativePath } from "../src/workspace-route.js";

const article = "公众号/职场号/创作/ART-001/article.md";

describe("WeChat workbench files", () => {
  it("lists and selects article files independently of fiction and drama", () => {
    expect(workbenchModeForPath(article)).toBe("wechat");
    expect(creativeRelativePath(`D:/stories/${article}`, "D:/stories")).toBe(article);
    expect(preferredWorkbenchFile([{ path: "正文/1.md" }, { path: "公众号/职场号/账号.json" }, { path: article }], "wechat")).toBe(article);
    expect(() => { assertCreativePath(article, "text"); }).not.toThrow();
    expect(() => { assertCreativePath(article.replace(".md", ".html"), "text"); }).not.toThrow();
    expect(() => { assertCreativePath("公众号/职场号/创作/ART-001/images/cover.png", "media"); }).not.toThrow();
    for (const path of ["公众号/../secret.md", "公众号/职场号/run.js", "正文/article.html"]) {
      expect(() => { assertCreativePath(path, "text"); }).toThrow();
    }
  });

  it("recovers Markdown and HTML drafts in their original session", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const scope = { sessionId: "wechat-session", cwd: "D:/stories" };
    const buffer = { content: "Edited article", saved: "Original", version: "v1", source: "human" as const };
    const html = article.replace(".md", ".html");
    const saved = writeDraftBackup(storage, scope, { [article]: buffer, [html]: buffer }, article, null);
    expect(saved.error).toBeUndefined();
    expect(readDraftBackup(storage, scope).buffers[html]?.content).toBe(buffer.content);
    expect(readDraftBackup(storage, { ...scope, sessionId: "another" }).buffers).toEqual({});
    const reference = "公众号/职场号/参考文章/original.md";
    expect(isWechatReferencePath(reference)).toBe(true);
    expect(writeDraftBackup(storage, scope, { [reference]: buffer }, reference, saved.snapshot).error).toBe("write-failed");
  });

  it("resolves local article images without allowing external or cross-account reads", () => {
    expect(wechatImagePath("images/cover.png", article)).toBe("公众号/职场号/创作/ART-001/images/cover.png");
    expect(wechatImagePath("images/%E5%B0%81%E9%9D%A2.png", article)).toBe("公众号/职场号/创作/ART-001/images/封面.png");
    for (const source of ["https://example.com/a.png", "//example.com/a.png", "file:///secret.png", "/secret.png", "../../../../其他号/a.png", "images/a.svg", "images\\a.png", "images/%2e%2e/%2e%2e/%2e%2e/%2e%2e/other/a.png"]) {
      expect(wechatImagePath(source, article), source).toBeUndefined();
    }
  });
});
