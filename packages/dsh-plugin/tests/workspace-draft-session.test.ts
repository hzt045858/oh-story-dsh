import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it, vi } from "vitest";
import { registerWorkspaceRoute } from "../src/workspace-route.js";

const SESSION_ID = SessionId("empty-draft-session");
const WORKSPACE = "D:/draft-workspace";
const ENDPOINT = `/oh-story/draft-session?sessionId=${SESSION_ID}`;

interface FixtureOptions {
  readonly lookup?: "missing" | "reject";
  readonly agent?: "missing";
  readonly cwd?: null;
  readonly fs?: "missing";
  readonly sandbox?: "missing" | "read-only";
  readonly persistence?: "missing" | "unsupported";
  readonly origin?: "subagent";
  readonly parentSession?: string;
}

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

interface RegisteredRoute {
  readonly kind: string;
  readonly path: string;
  readonly handler: RouteHandler;
}

function fixture(options: FixtureOptions = {}) {
  // No event, title, message, or tool methods: retaining a draft must only materialize its header.
  const session = Object.freeze({
    id: SESSION_ID,
    header: Object.freeze({
      id: SESSION_ID,
      ...(options.cwd === null ? {} : { cwd: WORKSPACE }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.parentSession === undefined ? {} : { parentSession: SessionId(options.parentSession) })
    })
  });
  const fs = {
    resolve: vi.fn(async (path: string) => ({ path })),
    contains: vi.fn(() => true),
    stat: vi.fn(async () => undefined),
    listDir: vi.fn(async () => [])
  };
  const sandboxPolicy = {
    defaultMode: options.sandbox === "read-only" ? "read-only" : "workspace-write",
    resolve: vi.fn(() => ({
      mode: options.sandbox === "read-only" ? "read-only" : "workspace-write",
      workspaceRoot: WORKSPACE
    }))
  };
  const agent = {
    session,
    ctx: {
      get: (name: string): unknown => {
        if (name === "fs") return options.fs === "missing" ? undefined : fs;
        if (name === "sandboxPolicy") return options.sandbox === "missing" ? undefined : sandboxPolicy;
        return undefined;
      }
    }
  };
  const resolveAgent = vi.fn(async () => {
    if (options.lookup === "reject") throw new Error("Session lookup failed");
    return options.agent === "missing" ? undefined : agent;
  });
  const flush = vi.fn<(value: unknown) => Promise<boolean>>().mockResolvedValue(true);
  const logError = vi.fn();
  const registrations: RegisteredRoute[] = [];
  const context = {
    effect: (callback: () => unknown): unknown => callback(),
    webServer: {
      register: (route: RegisteredRoute): (() => void) => {
        registrations.push(route);
        return () => {};
      }
    },
    typert: {
      lookups: new Map(options.lookup === "missing" ? [] : [["agent", { resolve: resolveAgent }]])
    },
    get: (name: string): unknown => {
      if (name !== "sessions" || options.persistence === "missing") return undefined;
      return options.persistence === "unsupported" ? {} : { flush };
    },
    logger: () => ({ error: logError })
  } as unknown as Context;
  registerWorkspaceRoute(context, { maxBytes: 1_024 });
  expect(registrations).toHaveLength(1);
  const registered = registrations[0];
  if (registered === undefined) throw new Error("Workspace route was not registered");
  expect(registered).toMatchObject({ kind: "prefix", path: "/oh-story" });
  return { handler: registered.handler, session, flush, resolveAgent, fs, sandboxPolicy, logError };
}

interface RunningRoute {
  readonly responses: readonly ServerResponse[];
  readonly request: (path?: string, method?: string, headers?: Readonly<Record<string, string>>) => Promise<Response>;
}

function requestRoute(port: number, path: string, method: string, headers: Readonly<Record<string, string>>): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      incoming.once("error", reject);
      incoming.once("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
        }
        resolve(new Response(Buffer.concat(chunks).toString("utf8"), {
          status: incoming.statusCode ?? 500,
          headers: responseHeaders
        }));
      });
    });
    request.once("error", reject);
    request.end();
  });
}

async function withRoute(subject: ReturnType<typeof fixture>, run: (route: RunningRoute) => Promise<void>): Promise<void> {
  const responses: ServerResponse[] = [];
  const server = createServer((request, response) => {
    responses.push(response);
    void subject.handler(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test server address");
    await run({
      responses,
      request: (path = ENDPOINT, method = "POST", headers = {}) => requestRoute(address.port, path, method, headers)
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
}

function deferred() {
  let release = (): void => { throw new Error("Deferred promise has not been initialized"); };
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("workspace draft Session persistence route", () => {
  it("materializes the exact live Session without creating a conversation event", async () => {
    const subject = fixture();
    await withRoute(subject, async ({ request }) => {
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessionId: SESSION_ID });
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
    expect(subject.resolveAgent).toHaveBeenCalledWith(SESSION_ID);
    expect(subject.flush).toHaveBeenCalledExactlyOnceWith(subject.session);
    expect(subject.flush.mock.calls[0]?.[0]).toBe(subject.session);
    expect(Object.keys(subject.session)).toEqual(["id", "header"]);
    expect(subject.fs.resolve).toHaveBeenCalledWith(WORKSPACE);
    expect(subject.fs.stat).not.toHaveBeenCalled();
    expect(subject.logError).not.toHaveBeenCalled();
  });

  it("does not acknowledge the backup before official durability completes", async () => {
    const subject = fixture();
    const entered = deferred();
    const durable = deferred();
    subject.flush.mockImplementation(async () => {
      entered.release();
      await durable.promise;
      return true;
    });
    await withRoute(subject, async ({ request, responses }) => {
      const pending = request();
      await entered.promise;
      const endedBeforeDurability = responses[0]?.writableEnded;
      durable.release();
      const response = await pending;
      expect(endedBeforeDurability).toBe(false);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessionId: SESSION_ID });
    });
  });

  it("delegates repeated requests to the official idempotent materialization method", async () => {
    const subject = fixture();
    await withRoute(subject, async ({ request }) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await request();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ sessionId: SESSION_ID });
      }
    });
    expect(subject.flush).toHaveBeenCalledTimes(2);
    expect(subject.flush.mock.calls.every(([value]) => value === subject.session)).toBe(true);
  });

  it("allows Session metadata retention in a read-only workspace", async () => {
    const subject = fixture({ sandbox: "read-only" });
    await withRoute(subject, async ({ request }) => {
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessionId: SESSION_ID });
    });
    expect(subject.flush).toHaveBeenCalledExactlyOnceWith(subject.session);
  });

  it.each([
    { name: "missing id", path: "/oh-story/draft-session", options: {}, status: 400 },
    { name: "empty id", path: "/oh-story/draft-session?sessionId=", options: {}, status: 400 },
    { name: "unavailable lookup", path: ENDPOINT, options: { lookup: "missing" }, status: 503 },
    { name: "failed lookup", path: ENDPOINT, options: { lookup: "reject" }, status: 404 },
    { name: "missing Agent", path: ENDPOINT, options: { agent: "missing" }, status: 404 },
    { name: "subagent origin", path: ENDPOINT, options: { origin: "subagent" }, status: 403 },
    { name: "child Session", path: ENDPOINT, options: { parentSession: "parent-session" }, status: 403 },
    { name: "missing workspace", path: ENDPOINT, options: { cwd: null }, status: 409 },
    { name: "missing filesystem", path: ENDPOINT, options: { fs: "missing" }, status: 503 },
    { name: "missing sandbox policy", path: ENDPOINT, options: { sandbox: "missing" }, status: 503 },
    { name: "missing persistence service", path: ENDPOINT, options: { persistence: "missing" }, status: 503 },
    { name: "unsupported persistence service", path: ENDPOINT, options: { persistence: "unsupported" }, status: 503 }
  ] satisfies readonly { name: string; path: string; options: FixtureOptions; status: number }[])(
    "rejects $name without attempting persistence",
    async ({ path, options, status }) => {
      const subject = fixture(options);
      await withRoute(subject, async ({ request }) => {
        const response = await request(path);
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error: expect.any(String) });
      });
      expect(subject.flush).not.toHaveBeenCalled();
    }
  );

  it.each<Readonly<Record<string, string>>>([
    { origin: "https://untrusted.example" },
    { "sec-fetch-site": "cross-site" },
    { host: "untrusted.example" }
  ])("rejects untrusted browser headers %j before resolving the Agent", async (headers) => {
    const subject = fixture();
    await withRoute(subject, async ({ request }) => {
      const response = await request(ENDPOINT, "POST", headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    });
    expect(subject.resolveAgent).not.toHaveBeenCalled();
    expect(subject.flush).not.toHaveBeenCalled();
  });

  it("reports persistence failure and permits a later successful retry", async () => {
    const subject = fixture();
    const failure = new Error("Session disk write failed");
    subject.flush.mockRejectedValueOnce(failure);
    await withRoute(subject, async ({ request }) => {
      const failed = await request();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: expect.any(String) });
      const retried = await request();
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({ sessionId: SESSION_ID });
    });
    expect(subject.flush).toHaveBeenCalledTimes(2);
    expect(subject.logError).toHaveBeenCalledWith("workspace route failed", failure);
  });

  it("does not materialize a Session through a GET to the draft endpoint", async () => {
    const subject = fixture();
    await withRoute(subject, async ({ request }) => {
      const response = await request(ENDPOINT, "GET");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    });
    expect(subject.resolveAgent).not.toHaveBeenCalled();
    expect(subject.flush).not.toHaveBeenCalled();
  });

  it("keeps ordinary workspace discovery free of Session persistence", async () => {
    const subject = fixture();
    await withRoute(subject, async ({ request }) => {
      const response = await request(`/oh-story/workspace?sessionId=${SESSION_ID}`, "GET");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ cwd: WORKSPACE, files: [], mode: "dsh-session" });
    });
    expect(subject.flush).not.toHaveBeenCalled();
  });
});
