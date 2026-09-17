import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftBackupKey, readDraftBackup, writeDraftBackup, type DraftBuffer, type DraftScope } from "../src/client/draft-backup.js";
import { hasDraftBackupLock } from "../src/client/draft-backup-lock.js";
import { checkDraftSession, persistDraftSession, restoreDraftSession, sameDraftScope, syncDraftSession, updateDraftUnloadGuard, type DraftSessionState } from "../src/client/draft-session.js";

vi.mock("../src/client/draft-backup-lock.js", () => ({ hasDraftBackupLock: vi.fn() }));

const scope: DraftScope = { sessionId: "session-a", cwd: "D:/writing/project-a" };
const story = "正文/chapter.md";
const drama = "剧集/EP001/script.md";
const draft: DraftBuffer = { content: "Human edit", saved: "Disk content", version: "disk-v1", source: "human" };

function session(): DraftSessionState {
  return { buffers: {}, draftScope: undefined, draftSnapshot: undefined, draftError: undefined, recoveredDrafts: 0 };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); })
  };
}

function seed(storage: ReturnType<typeof memoryStorage>, target = scope, buffers: Record<string, DraftBuffer> = { [story]: draft }, previous: string | null = null): string {
  const result = writeDraftBackup(storage, target, buffers, Object.keys(buffers)[0], previous);
  expect(result.error).toBeUndefined();
  expect(result.snapshot).not.toBeNull();
  return result.snapshot!;
}

describe("draft session restoration and persistence", () => {
  it("restores durable human drafts over clean buffers and counts only newly restored drafts", () => {
    const storage = memoryStorage();
    const snapshot = seed(storage, scope, { [story]: draft, [drama]: { ...draft, content: "" } });
    const state = session();
    state.buffers[story] = { content: draft.saved, saved: draft.saved, version: "disk-v1", source: "disk", error: "old error" };
    expect(restoreDraftSession(state, scope, storage)).toBe(story);
    expect(state.buffers).toEqual({ [story]: draft, [drama]: { ...draft, content: "" } });
    expect(state.draftSnapshot).toBe(snapshot);
    expect(state.draftError).toBeUndefined();
    expect(state.recoveredDrafts).toBe(2);
    state.recoveredDrafts = 0;
    expect(restoreDraftSession(state, scope, storage)).toBeUndefined();
    expect(state.recoveredDrafts).toBe(0);
    persistDraftSession(state, story, storage);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("retries an unavailable first read before persisting and retains new local input", () => {
    const storage = memoryStorage();
    const snapshot = seed(storage);
    const state = session();
    storage.getItem.mockImplementationOnce(() => { throw new Error("Storage blocked"); });
    expect(restoreDraftSession(state, scope, storage)).toBeUndefined();
    expect(state.draftSnapshot).toBeUndefined();
    expect(state.draftError).toBe("unavailable");
    state.buffers[drama] = { ...draft, content: "Typed while storage was unavailable" };
    persistDraftSession(state, drama, storage);
    expect(storage.values.get(draftBackupKey(scope))).toBe(snapshot);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(restoreDraftSession(state, scope, storage)).toBe(story);
    expect(state.buffers[story]).toEqual(draft);
    expect(state.buffers[drama]?.content).toBe("Typed while storage was unavailable");
    expect(state.draftError).toBeUndefined();
    persistDraftSession(state, drama, storage);
    expect(readDraftBackup(storage, scope).buffers).toEqual(state.buffers);
    expect(readDraftBackup(storage, scope).selected).toBe(drama);
  });

  it("does not overwrite a divergent stored draft after typing during an unavailable first read", () => {
    const storage = memoryStorage();
    const snapshot = seed(storage);
    const state = session();
    restoreDraftSession(state, scope, undefined);
    state.buffers[story] = { ...draft, content: "New local text" };
    expect(restoreDraftSession(state, scope, storage)).toBeUndefined();
    expect(state.draftError).toBe("changed");
    expect(state.draftSnapshot).toBeUndefined();
    persistDraftSession(state, story, storage);
    expect(state.buffers[story]?.content).toBe("New local text");
    expect(storage.values.get(draftBackupKey(scope))).toBe(snapshot);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("blocks automatic persistence after an invalid backup without partially restoring it", () => {
    const storage = memoryStorage();
    const state = session();
    const invalid = '{"schemaVersion":2,"buffers":{}}';
    storage.values.set(draftBackupKey(scope), invalid);
    state.buffers[story] = draft;
    expect(restoreDraftSession(state, scope, storage)).toBeUndefined();
    expect(state.draftError).toBe("invalid");
    expect(state.buffers).toEqual({ [story]: draft });
    persistDraftSession(state, story, storage);
    expect(storage.values.get(draftBackupKey(scope))).toBe(invalid);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("retries failed cleanup without resurrecting a draft already saved to disk", () => {
    const storage = memoryStorage();
    const original = seed(storage);
    const state = session();
    restoreDraftSession(state, scope, storage);
    const saved = { content: draft.content, saved: draft.content, version: "disk-v2", source: "disk" as const };
    state.buffers[story] = saved;
    storage.removeItem.mockImplementationOnce(() => { throw new Error("Removal blocked"); });
    persistDraftSession(state, story, storage);
    expect(state.draftError).toBe("write-failed");
    expect(state.draftSnapshot).toBe(original);
    expect(readDraftBackup(storage, scope).buffers[story]).toEqual(draft);
    expect(restoreDraftSession(state, scope, storage)).toBeUndefined();
    expect(state.buffers[story]).toBe(saved);
    expect(state.draftError).toBeUndefined();
    persistDraftSession(state, story, storage);
    expect(state.draftSnapshot).toBeNull();
    expect(state.draftError).toBeUndefined();
    expect(readDraftBackup(storage, scope).buffers).toEqual({});
    expect(storage.removeItem).toHaveBeenCalledTimes(2);
  });

  it.each([
    { content: "Other page content" },
    { saved: "Other page baseline" },
    { version: "other-page-version" }
  ])("rejects a same-path conflict when another page changes %j", (change) => {
    const storage = memoryStorage();
    const first = seed(storage);
    const state = session();
    restoreDraftSession(state, scope, storage);
    state.buffers[story] = { ...draft, content: "Latest local edit" };
    const local = state.buffers[story];
    const other = seed(storage, scope, { [story]: { ...local, ...change }, [drama]: draft }, first);
    checkDraftSession(state, storage);
    expect(state.draftError).toBe("changed");
    expect(restoreDraftSession(state, scope, storage)).toBeUndefined();
    expect(state.buffers).toEqual({ [story]: local });
    expect(state.draftSnapshot).toBe(first);
    expect(state.draftError).toBe("changed");
    persistDraftSession(state, story, storage);
    expect(storage.values.get(draftBackupKey(scope))).toBe(other);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("merges another page's independent path while preserving a local dirty draft", () => {
    const storage = memoryStorage();
    const state = session();
    restoreDraftSession(state, scope, storage);
    state.buffers[story] = draft;
    const other = seed(storage, scope, { [drama]: { ...draft, content: "Other project draft" } });
    checkDraftSession(state, storage);
    expect(state.draftError).toBe("changed");
    expect(restoreDraftSession(state, scope, storage)).toBe(drama);
    expect(state.buffers[story]).toBe(draft);
    expect(state.buffers[drama]?.content).toBe("Other project draft");
    expect(state.draftSnapshot).toBe(other);
    expect(state.draftError).toBeUndefined();
    expect(state.recoveredDrafts).toBe(1);
    persistDraftSession(state, story, storage);
    expect(readDraftBackup(storage, scope).buffers).toEqual(state.buffers);
  });

  it("persists the post-save merged buffer with subsequent input and the new disk baseline", () => {
    const storage = memoryStorage();
    const state = session();
    restoreDraftSession(state, scope, storage);
    state.buffers[story] = { ...draft, content: "Submitted text", saving: true };
    persistDraftSession(state, story, storage);
    state.buffers[story] = { ...state.buffers[story], content: "Submitted text\nLater input" };
    persistDraftSession(state, story, storage);
    state.buffers[story] = { content: "Submitted text\nLater input", saved: "Submitted text", version: "disk-v2", source: "human", saving: false };
    persistDraftSession(state, story, storage);
    expect(readDraftBackup(storage, scope).buffers[story]).toEqual({
      content: "Submitted text\nLater input", saved: "Submitted text", version: "disk-v2", source: "human"
    });
    const restored = session();
    expect(restoreDraftSession(restored, scope, storage)).toBe(story);
    expect(restored.buffers[story]?.content).toBe("Submitted text\nLater input");
    state.buffers[story] = { content: "Submitted text\nLater input", saved: "Submitted text\nLater input", version: "disk-v3", source: "disk" };
    persistDraftSession(state, story, storage);
    expect(state.draftSnapshot).toBeNull();
    expect(readDraftBackup(storage, scope).buffers).toEqual({});
  });

  it("can retry a failed write when the existing backup is still this page's own snapshot", () => {
    const storage = memoryStorage();
    const original = seed(storage);
    const state = session();
    restoreDraftSession(state, scope, storage);
    state.buffers[story] = { ...draft, content: "New unsaved input" };
    storage.setItem.mockImplementationOnce(() => { throw new Error("Quota exceeded"); });
    persistDraftSession(state, story, storage);
    expect(state.draftError).toBe("write-failed");
    expect(state.draftSnapshot).toBe(original);
    expect(restoreDraftSession(state, scope, storage)).toBeUndefined();
    expect(state.draftError).toBeUndefined();
    expect(state.buffers[story]?.content).toBe("New unsaved input");
    persistDraftSession(state, story, storage);
    expect(state.draftError).toBeUndefined();
    expect(readDraftBackup(storage, scope).buffers[story]?.content).toBe("New unsaved input");
  });

  it.each([
    { ...scope, sessionId: "session-b" },
    { ...scope, cwd: "D:/writing/project-b" }
  ])("clears stale state when switching to isolated scope %j", (next) => {
    const storage = memoryStorage();
    const first = seed(storage);
    const second = seed(storage, next, { [drama]: { ...draft, content: "Second scope" } });
    const state = session();
    restoreDraftSession(state, scope, storage);
    state.draftError = "write-failed";
    expect(sameDraftScope(state.draftScope, next)).toBe(false);
    expect(restoreDraftSession(state, next, storage)).toBe(drama);
    expect(state.buffers).toEqual({ [drama]: { ...draft, content: "Second scope" } });
    expect(state.draftSnapshot).toBe(second);
    expect(state.draftError).toBeUndefined();
    expect(state.recoveredDrafts).toBe(1);
    expect(sameDraftScope(state.draftScope, next)).toBe(true);
    state.buffers = {};
    persistDraftSession(state, undefined, storage);
    expect(storage.values.get(draftBackupKey(next))).toBeUndefined();
    expect(storage.values.get(draftBackupKey(scope))).toBe(first);
  });

  it("does not reuse the previous scope's snapshot when the new scope cannot be read", () => {
    const storage = memoryStorage();
    const original = seed(storage);
    const state = session();
    restoreDraftSession(state, scope, storage);
    const next = { ...scope, cwd: "D:/writing/unavailable" };
    expect(restoreDraftSession(state, next, undefined)).toBeUndefined();
    expect(state.buffers).toEqual({});
    expect(state.draftScope).toEqual(next);
    expect(state.draftSnapshot).toBeUndefined();
    expect(state.recoveredDrafts).toBe(0);
    expect(state.draftError).toBe("unavailable");
    state.buffers[drama] = { ...draft, content: "New workspace input" };
    persistDraftSession(state, drama, storage);
    expect(storage.values.has(draftBackupKey(next))).toBe(false);
    expect(storage.values.get(draftBackupKey(scope))).toBe(original);
    restoreDraftSession(state, next, storage);
    persistDraftSession(state, drama, storage);
    expect(readDraftBackup(storage, next).buffers[drama]?.content).toBe("New workspace input");
    expect(storage.values.get(draftBackupKey(scope))).toBe(original);
  });
});

describe("draft sync ownership and Session readiness", () => {
  let events: EventTarget;
  const watchedScopes = new Map<string, DraftScope>();

  function scopedSession(target = scope): DraftSessionState {
    watchedScopes.set(draftBackupKey(target), target);
    return { ...session(), draftScope: target, draftSnapshot: null, draftSessionReady: false, buffers: { [story]: draft } };
  }

  function preventsUnload(): boolean {
    const event = new Event("beforeunload", { cancelable: true });
    events.dispatchEvent(event);
    return event.defaultPrevented;
  }

  beforeEach(() => {
    events = new EventTarget();
    vi.stubGlobal("addEventListener", vi.fn(events.addEventListener.bind(events)));
    vi.stubGlobal("removeEventListener", vi.fn(events.removeEventListener.bind(events)));
    vi.mocked(hasDraftBackupLock).mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    for (const target of watchedScopes.values()) {
      updateDraftUnloadGuard({ ...session(), draftScope: target, draftSnapshot: null, draftSessionReady: true });
    }
    watchedScopes.clear();
    vi.unstubAllGlobals();
  });

  it("does not read or write storage before its scope has been established", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const state = session();
    state.buffers[story] = draft;
    syncDraftSession(state, story);
    expect(hasDraftBackupLock).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(state.draftSnapshot).toBeUndefined();
    expect(preventsUnload()).toBe(false);
  });

  it("marks an unowned draft busy without reading or changing storage", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const state = scopedSession();
    syncDraftSession(state, story);
    expect(hasDraftBackupLock).toHaveBeenCalledWith(scope);
    expect(state.draftError).toBe("busy");
    expect(state.draftSnapshot).toBeNull();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(preventsUnload()).toBe(true);
    state.buffers = {};
    syncDraftSession(state, undefined);
    expect(preventsUnload()).toBe(false);
  });

  it("does not silently write when Web Locks are unavailable", () => {
    const storage = memoryStorage();
    const snapshot = seed(storage);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("navigator", undefined);
    const state = scopedSession();
    state.draftSnapshot = snapshot;
    state.draftError = "unavailable";
    state.buffers[story] = { ...draft, content: "Cannot acquire a browser lock" };
    const reads = storage.getItem.mock.calls.length;
    syncDraftSession(state, story);
    expect(state.draftError).toBe("unavailable");
    expect(state.draftSnapshot).toBe(snapshot);
    expect(storage.getItem).toHaveBeenCalledTimes(reads);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.values.get(draftBackupKey(scope))).toBe(snapshot);
    expect(preventsUnload()).toBe(true);
  });

  it("keeps an unmaterialized Session protected after a successful local backup", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.mocked(hasDraftBackupLock).mockReturnValue(true);
    const state = scopedSession();
    syncDraftSession(state, story);
    expect(state.draftError).toBeUndefined();
    expect(readDraftBackup(storage, scope).buffers[story]).toEqual(draft);
    expect(preventsUnload()).toBe(true);
    updateDraftUnloadGuard(state);
    expect(preventsUnload()).toBe(true);
    state.draftSessionReady = true;
    updateDraftUnloadGuard(state);
    expect(preventsUnload()).toBe(false);
    expect(globalThis.removeEventListener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("protects a materialized Session again when a later storage write fails", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.mocked(hasDraftBackupLock).mockReturnValue(true);
    const state = scopedSession();
    state.draftSessionReady = true;
    syncDraftSession(state, story);
    const first = state.draftSnapshot;
    expect(preventsUnload()).toBe(false);
    state.buffers[story] = { ...draft, content: "Later input" };
    storage.setItem.mockImplementationOnce(() => { throw new Error("Quota exceeded"); });
    syncDraftSession(state, story);
    expect(state.draftError).toBe("write-failed");
    expect(state.draftSnapshot).toBe(first);
    expect(preventsUnload()).toBe(true);
    restoreDraftSession(state, scope, storage);
    syncDraftSession(state, story);
    expect(state.draftError).toBeUndefined();
    expect(readDraftBackup(storage, scope).buffers[story]?.content).toBe("Later input");
    expect(preventsUnload()).toBe(false);
  });

  it("does not let a ready scope clear another Session's outstanding unload guard", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.mocked(hasDraftBackupLock).mockReturnValue(true);
    const pending = scopedSession();
    const other = scopedSession({ ...scope, sessionId: "session-b" });
    other.draftSessionReady = true;
    syncDraftSession(pending, story);
    syncDraftSession(other, story);
    expect(preventsUnload()).toBe(true);
    updateDraftUnloadGuard(other);
    expect(preventsUnload()).toBe(true);
    pending.draftSessionReady = true;
    updateDraftUnloadGuard(pending);
    expect(preventsUnload()).toBe(false);
  });

  it("resets Session readiness on a scope switch and cannot use the old scope's lock", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.mocked(hasDraftBackupLock).mockImplementation((target) => sameDraftScope(target, scope));
    const state = scopedSession();
    state.draftSessionReady = true;
    syncDraftSession(state, story);
    const oldSnapshot = state.draftSnapshot;
    const next = { ...scope, cwd: "D:/writing/project-b" };
    watchedScopes.set(draftBackupKey(next), next);
    const nextSnapshot = seed(storage, next, { [drama]: { ...draft, content: "Next workspace draft" } });
    expect(restoreDraftSession(state, next, storage)).toBe(drama);
    expect(state.draftSessionReady).toBe(false);
    const writes = storage.setItem.mock.calls.length;
    syncDraftSession(state, drama);
    expect(state.draftError).toBe("busy");
    expect(storage.setItem).toHaveBeenCalledTimes(writes);
    expect(storage.values.get(draftBackupKey(scope))).toBe(oldSnapshot);
    expect(storage.values.get(draftBackupKey(next))).toBe(nextSnapshot);
    expect(preventsUnload()).toBe(true);
    vi.mocked(hasDraftBackupLock).mockImplementation((target) => sameDraftScope(target, next));
    restoreDraftSession(state, next, storage);
    syncDraftSession(state, drama);
    expect(state.draftError).toBeUndefined();
    expect(preventsUnload()).toBe(true);
    state.draftSessionReady = true;
    updateDraftUnloadGuard(state);
    expect(preventsUnload()).toBe(false);
  });

  it.each(["invalid", "changed"] as const)("retains %s protection even when this page owns the lock", (error) => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.mocked(hasDraftBackupLock).mockReturnValue(true);
    const state = scopedSession();
    state.draftSessionReady = true;
    state.draftError = error;
    syncDraftSession(state, story);
    expect(state.draftError).toBe(error);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(preventsUnload()).toBe(true);
  });
});
