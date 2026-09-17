import { afterEach, describe, expect, it, vi } from "vitest";
import { draftBackupKey, draftBackupStorage, isDirtyDraft, readDraftBackup, writeDraftBackup, type DraftBuffer, type DraftScope } from "../src/client/draft-backup.js";

const scope: DraftScope = { sessionId: "session-a", cwd: "D:/writing/project" };
const story = "正文/chapter.md";
const drama = "剧集/EP001/script.md";
const draft: DraftBuffer = { content: "Edited content", saved: "Disk content", version: "version-1", source: "human" };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); })
  };
}

function seed(storage: ReturnType<typeof memoryStorage>, buffers: Record<string, DraftBuffer> = { [story]: draft }) {
  const result = writeDraftBackup(storage, scope, buffers, story, null);
  expect(result.error).toBeUndefined();
  expect(result.snapshot).not.toBeNull();
  return result.snapshot!;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("session draft backups", () => {
  it("isolates sessions and workspaces with unambiguous scope keys", () => {
    const storage = memoryStorage();
    const scopes = [scope, { ...scope, sessionId: "session-b" }, { ...scope, cwd: "D:/writing/another" },
      { sessionId: "a:b", cwd: "c" }, { sessionId: "a", cwd: "b:c" }];
    for (const [index, target] of scopes.entries()) {
      const buffer = { ...draft, content: `draft-${String(index)}` };
      expect(writeDraftBackup(storage, target, { [story]: buffer }, story, null).error).toBeUndefined();
    }
    expect(storage.values.size).toBe(scopes.length);
    expect(new Set(scopes.map(draftBackupKey)).size).toBe(scopes.length);
    for (const [index, target] of scopes.entries()) expect(readDraftBackup(storage, target).buffers[story]?.content).toBe(`draft-${String(index)}`);
  });

  it("backs up only dirty human text and restores only the durable fields", () => {
    const storage = memoryStorage();
    const transient = { ...draft, saving: true, error: "failed", conflict: { remote: "other" }, agent: "write-1" };
    const buffers = {
      [story]: transient,
      [drama]: { ...draft, content: "" },
      "正文/saved.md": { ...draft, content: draft.saved },
      "正文/agent.md": { ...draft, source: "agent" as const },
      "正文/disk.md": { ...draft, source: "disk" as const }
    };
    const snapshot = seed(storage, buffers);
    const result = readDraftBackup(storage, scope);
    expect(result).toEqual({ snapshot, selected: story, buffers: { [story]: draft, [drama]: { ...draft, content: "" } } });
    expect(snapshot).not.toMatch(/saving|conflict|failed|write-1|"source"|agent\.md|disk\.md|saved\.md/u);
    expect(isDirtyDraft(draft)).toBe(true);
    expect(isDirtyDraft({ ...draft, content: "" })).toBe(true);
    expect(isDirtyDraft({ ...draft, source: "agent" })).toBe(false);
    expect(isDirtyDraft({ ...draft, content: draft.saved })).toBe(false);
    expect(isDirtyDraft(undefined)).toBe(false);
  });

  it("uses a dirty selection or the first stable fallback and avoids redundant writes", () => {
    const storage = memoryStorage();
    const first = writeDraftBackup(storage, scope, { [story]: draft, [drama]: draft }, "正文/not-dirty.md", null);
    const expected = [story, drama].sort()[0];
    expect(readDraftBackup(storage, scope).selected).toBe(expected);
    const repeated = writeDraftBackup(storage, scope, { [drama]: draft, [story]: draft }, undefined, first.snapshot);
    expect(repeated).toEqual(first);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const selected = writeDraftBackup(storage, scope, { [story]: draft, [drama]: draft }, story, first.snapshot);
    expect(readDraftBackup(storage, scope).selected).toBe(story);
    expect(selected.error).toBeUndefined();
  });

  it("removes a backup only after no dirty human buffers remain", () => {
    const storage = memoryStorage();
    const previous = seed(storage);
    expect(writeDraftBackup(storage, scope, { [story]: { ...draft, saved: draft.content } }, story, previous)).toEqual({ snapshot: null });
    expect(readDraftBackup(storage, scope)).toEqual({ snapshot: null, buffers: {} });
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect(writeDraftBackup(storage, scope, {}, undefined, null)).toEqual({ snapshot: null });
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
  });

  it("keeps existing snapshots when quota or removal is rejected", () => {
    const storage = memoryStorage();
    const previous = seed(storage);
    storage.setItem.mockImplementation(() => { throw new Error("Quota exceeded"); });
    expect(writeDraftBackup(storage, scope, { [story]: { ...draft, content: "Next edit" } }, story, previous))
      .toEqual({ snapshot: previous, error: "write-failed" });
    expect(readDraftBackup(storage, scope).snapshot).toBe(previous);
    storage.removeItem.mockImplementation(() => { throw new Error("Removal refused"); });
    expect(writeDraftBackup(storage, scope, {}, undefined, previous)).toEqual({ snapshot: previous, error: "write-failed" });
    expect(readDraftBackup(storage, scope).snapshot).toBe(previous);
  });

  it("refuses both writes and cleanup after another page changed the backup", () => {
    const storage = memoryStorage();
    const first = seed(storage);
    const second = writeDraftBackup(storage, scope, { [story]: { ...draft, content: "Other page" } }, story, first).snapshot;
    const writes = storage.setItem.mock.calls.length;
    expect(writeDraftBackup(storage, scope, { [story]: draft }, story, first)).toEqual({ snapshot: first, error: "changed" });
    expect(writeDraftBackup(storage, scope, {}, undefined, first)).toEqual({ snapshot: first, error: "changed" });
    expect(storage.setItem).toHaveBeenCalledTimes(writes);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(readDraftBackup(storage, scope).snapshot).toBe(second);
    expect(writeDraftBackup(storage, scope, {}, undefined, second)).toEqual({ snapshot: null });
    expect(writeDraftBackup(storage, scope, { [story]: draft }, story, first)).toEqual({ snapshot: first, error: "changed" });
  });

  it("reports unavailable storage without throwing or losing the expected snapshot", () => {
    const storage = memoryStorage();
    const previous = seed(storage);
    storage.getItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    expect(readDraftBackup(storage, scope)).toEqual({ snapshot: undefined, buffers: {}, error: "unavailable" });
    expect(writeDraftBackup(storage, scope, {}, undefined, previous)).toEqual({ snapshot: previous, error: "unavailable" });
    expect(readDraftBackup(undefined, scope)).toEqual({ snapshot: undefined, buffers: {}, error: "unavailable" });
    expect(writeDraftBackup(undefined, scope, {}, undefined, previous)).toEqual({ snapshot: previous, error: "unavailable" });
    vi.stubGlobal("localStorage", storage);
    expect(draftBackupStorage()).toBe(storage);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Property access blocked"); } });
    expect(draftBackupStorage()).toBeUndefined();
  });

  it("rejects invalid snapshots completely without deleting or partially recovering them", () => {
    const storage = memoryStorage();
    const previous = seed(storage);
    const key = storage.setItem.mock.calls[0]![0];
    const valid = JSON.parse(previous) as { schemaVersion: number; scope: DraftScope; buffers: Record<string, unknown>; selected: string };
    const invalidBuffers = [
      { [story]: { content: "edit", saved: "disk", version: 1 } },
      { [story]: { content: "edit", saved: "disk", version: "v1", saving: true } },
      { [story]: { content: "same", saved: "same", version: "v1" } },
      { [story]: null },
      {}
    ];
    const unsafePaths = ["__proto__", "constructor", "prototype", "正文/../outside.md", "./正文/file.md", "正文\\file.md", "/正文/file.md",
      "game-adaptations/demo/design.md", "video-recaps/demo/script.md"];
    const invalid = ["not json", "null", "[]", JSON.stringify({ ...valid, schemaVersion: 2 }),
      JSON.stringify({ ...valid, scope: { ...scope, sessionId: "another" } }),
      JSON.stringify({ ...valid, scope: { ...scope, cwd: "another" } }),
      JSON.stringify({ ...valid, selected: 7 }), JSON.stringify({ ...valid, selected: "../outside.md" }),
      JSON.stringify({ ...valid, extra: true }),
      ...invalidBuffers.map((buffers) => JSON.stringify({ ...valid, buffers })),
      ...unsafePaths.map((path) => JSON.stringify({ ...valid, buffers: { ...valid.buffers, [path]: { content: "edit", saved: "disk", version: "v1" } } }))];
    for (const snapshot of invalid) {
      storage.values.set(key, snapshot);
      expect(readDraftBackup(storage, scope), snapshot).toEqual({ snapshot, buffers: {}, error: "invalid" });
      expect(storage.values.get(key)).toBe(snapshot);
    }
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("falls back for a missing selected draft and rejects unsafe dirty input before writing", () => {
    const storage = memoryStorage();
    const previous = seed(storage);
    const key = storage.setItem.mock.calls[0]![0];
    const value = JSON.parse(previous) as Record<string, unknown>;
    const withoutSelection = JSON.stringify({ ...value, selected: "正文/removed.md" });
    storage.values.set(key, withoutSelection);
    expect(readDraftBackup(storage, scope).selected).toBe(story);
    for (const path of ["__proto__", "正文/../escape.md", "game-adaptations/demo/a.md", "video-recaps/demo/a.md"]) {
      expect(writeDraftBackup(storage, scope, { [path]: draft }, undefined, withoutSelection)).toEqual({ snapshot: withoutSelection, error: "write-failed" });
      expect(storage.values.get(key)).toBe(withoutSelection);
    }
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});
