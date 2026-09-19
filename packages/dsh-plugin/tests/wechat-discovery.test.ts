import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { registerWorkspaceRoute } from "../src/workspace-route.js";

interface ListedFile { readonly path: string; readonly kind: string; readonly version: string }
interface Listing { readonly files: readonly ListedFile[]; readonly games: readonly { readonly id: string }[]; readonly videos: readonly { readonly root: string }[] }

async function discover(wechatFiles: number, extraChapters = 0): Promise<Listing> {
  const paths = [
    "正文/chapter.md", "剧集/EP001/剧本.md", "game-adaptations/game/PRODUCT_BRIEF.md",
    "video-recaps/video/work/project.json", "short-drama.json",
    ...Array.from({ length: extraChapters }, (_, index) => `正文/extra-${index}.md`),
    ...Array.from({ length: wechatFiles }, (_, index) => `公众号/account/参考文章/${index}.md`)
  ];
  const directories = new Map<string, Map<string, "file" | "directory">>();
  const files = new Set(paths);
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      const entries = directories.get(parent) ?? new Map<string, "file" | "directory">();
      entries.set(parts[index]!, index === parts.length - 1 ? "file" : "directory");
      directories.set(parent, entries);
    }
  }
  const fs = {
    resolve: async (path: string) => ({ path }),
    contains: () => true,
    stat: async ({ path }: { readonly path: string }) => files.has(path)
      ? { type: "file", size: 2, version: "v1" }
      : directories.has(path) ? { type: "directory", version: "v1" } : undefined,
    listDir: async ({ path }: { readonly path: string }) => [...(directories.get(path) ?? [])].map(([name, type]) => ({
      name, type, target: { path: `${path}/${name}` }, size: 2, version: "v1"
    })),
    readBytes: async () => Buffer.from("{}")
  };
  const agent = { session: { id: "wechat-discovery", header: { cwd: "D:/workspace" } }, ctx: { get: (name: string) => name === "fs" ? fs : {} } };
  let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
  const context = {
    effect: (callback: () => unknown) => callback(),
    webServer: { register: (route: { readonly handler: NonNullable<typeof handler> }) => { handler = route.handler; return () => {}; } },
    typert: { lookups: new Map([["agent", { resolve: async () => agent }]]) },
    logger: () => ({ error: (message: string, error: unknown) => { throw new Error(message, { cause: error }); } })
  } as unknown as Context;
  registerWorkspaceRoute(context, { maxBytes: 1_024 });
  let status = 0;
  let result: Listing | undefined;
  if (handler === undefined) throw new Error("Workspace route was not registered");
  await handler({ headers: { host: "127.0.0.1" }, method: "GET", url: "/oh-story/workspace?sessionId=wechat-discovery" } as IncomingMessage, {
    writeHead: (code: number) => { status = code; },
    end: (body: string) => { result = JSON.parse(body) as Listing; }
  } as unknown as ServerResponse);
  expect(status).toBe(200);
  if (result === undefined) throw new Error("Workspace route returned no listing");
  return result;
}

describe("independent WeChat workspace discovery", () => {
  it("preserves all existing workbench files and project discovery with a large WeChat corpus", async () => {
    const before = await discover(0);
    const after = await discover(1_500);
    expect(before.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      "正文/chapter.md", "剧集/EP001/剧本.md", "game-adaptations/game/PRODUCT_BRIEF.md",
      "video-recaps/video/work/project.json", "short-drama.json"
    ]));
    expect(after.files.filter((file) => !file.path.startsWith("公众号/"))).toEqual(before.files);
    expect(after.games).toEqual(before.games);
    expect(after.videos).toEqual(before.videos);
    expect(after.files.filter((file) => file.path.startsWith("公众号/"))).toHaveLength(1_000);
  });

  it("still discovers WeChat when the existing workbenches have exhausted their original budget", async () => {
    const before = await discover(0, 1_100);
    const after = await discover(1_500, 1_100);
    expect(after.files.filter((file) => !file.path.startsWith("公众号/"))).toEqual(before.files);
    expect(after.files.filter((file) => file.path.startsWith("公众号/"))).toHaveLength(1_000);
    expect(after.files.filter((file) => file.path.startsWith("正文/"))).toHaveLength(998);
    expect(after.files.some((file) => file.path === "short-drama.json")).toBe(true);
  });
});
