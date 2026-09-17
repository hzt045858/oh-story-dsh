import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDraftBackupLock, hasDraftBackupLock } from "../src/client/draft-backup-lock.js";
import { draftBackupKey, type DraftScope } from "../src/client/draft-backup.js";

const scope: DraftScope = { sessionId: "session-a", cwd: "D:/writing/project" };
const cleanups: (() => void)[] = [];
type LockCallback = (lock: { readonly name: string; readonly mode: "exclusive" } | null) => Promise<void>;
type LockRequest = {
  readonly name: string;
  readonly callback: LockCallback;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
};

function fakeLocks() {
  const pending: LockRequest[] = [];
  return {
    pending,
    request: vi.fn((name: string, _options: { readonly mode: "exclusive"; readonly ifAvailable: true }, callback: LockCallback) => new Promise<void>((resolve, reject) => {
      pending.push({ name, callback, resolve, reject });
    })),
    grant(index: number, available = true): Promise<void> {
      const entry = pending[index]!;
      const result = entry.callback(available ? { name: entry.name, mode: "exclusive" } : null);
      void result.then(entry.resolve, entry.reject);
      return result;
    }
  };
}

function acquire(target = scope, onResult = vi.fn<(result: "owned" | "busy" | "unavailable") => void>()) {
  const cleanup = acquireDraftBackupLock(target, onResult);
  cleanups.push(cleanup);
  return { cleanup, onResult };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.resolve();
  vi.unstubAllGlobals();
});

describe("draft backup lifetime ownership", () => {
  it("holds an exclusive nonblocking browser lock until cleanup", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const owner = acquire();
    expect(locks.request).toHaveBeenCalledWith(draftBackupKey(scope), { mode: "exclusive", ifAvailable: true }, expect.any(Function));
    expect(hasDraftBackupLock(scope)).toBe(false);
    expect(owner.onResult).not.toHaveBeenCalled();
    const held = locks.grant(0);
    const finished = vi.fn();
    void held.then(finished);
    expect(owner.onResult).toHaveBeenCalledExactlyOnceWith("owned");
    expect(hasDraftBackupLock(scope)).toBe(true);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    owner.cleanup();
    expect(hasDraftBackupLock(scope)).toBe(false);
    await held;
    expect(finished).toHaveBeenCalledTimes(1);
    owner.cleanup();
    expect(owner.onResult).toHaveBeenCalledTimes(1);
  });

  it("reports a busy scope without claiming or releasing an earlier owner's lock", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const first = acquire();
    const held = locks.grant(0);
    const second = acquire();
    await locks.grant(1, false);
    expect(second.onResult).toHaveBeenCalledExactlyOnceWith("busy");
    expect(hasDraftBackupLock(scope)).toBe(true);
    second.cleanup();
    expect(hasDraftBackupLock(scope)).toBe(true);
    first.cleanup();
    await held;
    expect(hasDraftBackupLock(scope)).toBe(false);
  });

  it("releases a late grant silently after cleanup before approval", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const owner = acquire();
    owner.cleanup();
    await locks.grant(0);
    expect(owner.onResult).not.toHaveBeenCalled();
    expect(hasDraftBackupLock(scope)).toBe(false);
  });

  it("cannot remove a newer ownership token when an old request finishes", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const first = acquire();
    const firstHeld = locks.grant(0);
    first.cleanup();
    const second = acquire();
    const secondHeld = locks.grant(1);
    expect(hasDraftBackupLock(scope)).toBe(true);
    await firstHeld;
    first.cleanup();
    expect(hasDraftBackupLock(scope)).toBe(true);
    expect(second.onResult).toHaveBeenCalledExactlyOnceWith("owned");
    second.cleanup();
    await secondHeld;
    expect(hasDraftBackupLock(scope)).toBe(false);
  });

  it("isolates ownership for different sessions and workspaces", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const targets = [scope, { ...scope, sessionId: "session-b" }, { ...scope, cwd: "D:/writing/another" }];
    const owners = targets.map((target) => acquire(target));
    const held = targets.map((_target, index) => locks.grant(index));
    expect(new Set(locks.pending.map((entry) => entry.name)).size).toBe(3);
    for (const target of targets) expect(hasDraftBackupLock(target)).toBe(true);
    owners[0]!.cleanup();
    await held[0];
    expect(hasDraftBackupLock(scope)).toBe(false);
    for (const target of targets.slice(1)) expect(hasDraftBackupLock(target)).toBe(true);
    for (const owner of owners.slice(1)) owner.cleanup();
    await Promise.all(held);
  });

  it("reports unavailable for a missing LockManager or rejected property access", () => {
    for (const navigator of [undefined, {}, { locks: {} }]) {
      vi.stubGlobal("navigator", navigator);
      expect(acquire().onResult).toHaveBeenCalledExactlyOnceWith("unavailable");
      expect(hasDraftBackupLock(scope)).toBe(false);
    }
    Object.defineProperty(globalThis, "navigator", { configurable: true, get() { throw new Error("Navigator unavailable"); } });
    expect(acquire().onResult).toHaveBeenCalledExactlyOnceWith("unavailable");
    vi.stubGlobal("navigator", { get locks() { throw new Error("Locks blocked"); } });
    expect(acquire().onResult).toHaveBeenCalledExactlyOnceWith("unavailable");
  });

  it("reports synchronous and asynchronous request failures without leaving ownership", async () => {
    vi.stubGlobal("navigator", { locks: { request() { throw new Error("Access denied"); } } });
    expect(acquire().onResult).toHaveBeenCalledExactlyOnceWith("unavailable");
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const owner = acquire();
    locks.pending[0]!.reject(new Error("Request rejected"));
    await Promise.resolve();
    expect(owner.onResult).toHaveBeenCalledExactlyOnceWith("unavailable");
    expect(hasDraftBackupLock(scope)).toBe(false);
    await locks.grant(0);
    expect(owner.onResult).toHaveBeenCalledTimes(1);
    expect(hasDraftBackupLock(scope)).toBe(false);
  });

  it("suppresses late failure notifications after cleanup", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const owner = acquire();
    owner.cleanup();
    locks.pending[0]!.reject(new Error("Late rejection"));
    await Promise.resolve();
    expect(owner.onResult).not.toHaveBeenCalled();
    expect(hasDraftBackupLock(scope)).toBe(false);
  });

  it("releases an owned lock when its lifetime request fails", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const owner = acquire();
    const held = locks.grant(0);
    locks.pending[0]!.reject(new Error("Lock manager lost the request"));
    await held;
    expect(owner.onResult.mock.calls).toEqual([["owned"], ["unavailable"]]);
    expect(hasDraftBackupLock(scope)).toBe(false);
  });
});
