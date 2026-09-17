import { creativeRelativePath, workbenchModeForPath } from "./file-activity.js";
import { isWechatReferencePath } from "../wechat-files.js";

export type DraftScope = { readonly sessionId: string; readonly cwd: string };
export type DraftBuffer = {
  readonly content: string;
  readonly saved: string;
  readonly version: string;
  readonly source: "disk" | "human" | "agent";
};
export type DraftStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

type StoredBuffer = Pick<DraftBuffer, "content" | "saved" | "version">;
type RestoredBuffer = StoredBuffer & { readonly source: "human" };
type BackupRead = {
  readonly snapshot: string | null | undefined;
  readonly buffers: Record<string, RestoredBuffer>;
  readonly selected?: string;
  readonly error?: "unavailable" | "invalid";
};
type BackupWrite = {
  readonly snapshot: string | null;
  readonly error?: "unavailable" | "changed" | "write-failed";
};

export function draftBackupStorage(): DraftStorage | undefined {
  try { return globalThis.localStorage; }
  catch { return undefined; }
}

export function isDirtyDraft(buffer: DraftBuffer | undefined): boolean {
  return buffer?.source === "human" && buffer.content !== buffer.saved;
}

export function draftBackupKey(scope: DraftScope): string {
  return `oh-story.draft-backup.v1.${JSON.stringify([scope.sessionId, scope.cwd])}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validScope(value: unknown): value is DraftScope {
  return isRecord(value) && onlyKeys(value, ["sessionId", "cwd"])
    && typeof value.sessionId === "string" && value.sessionId !== ""
    && typeof value.cwd === "string" && value.cwd !== "";
}

function validPath(path: string): boolean {
  const mode = workbenchModeForPath(path);
  return creativeRelativePath(path, undefined) === path && !isWechatReferencePath(path) && (mode === "story" || mode === "drama" || mode === "wechat");
}

function validStoredBuffer(value: unknown): value is StoredBuffer {
  return isRecord(value) && onlyKeys(value, ["content", "saved", "version"])
    && typeof value.content === "string" && typeof value.saved === "string" && typeof value.version === "string"
    && value.content !== value.saved;
}

export function readDraftBackup(storage: DraftStorage | undefined, scope: DraftScope): BackupRead {
  if (storage === undefined) return { snapshot: undefined, buffers: {}, error: "unavailable" };
  let snapshot: string | null;
  try { snapshot = storage.getItem(draftBackupKey(scope)); }
  catch { return { snapshot: undefined, buffers: {}, error: "unavailable" }; }
  if (snapshot === null) return { snapshot, buffers: {} };
  const invalid: BackupRead = { snapshot, buffers: {}, error: "invalid" };
  try {
    const payload: unknown = JSON.parse(snapshot);
    if (!isRecord(payload) || !onlyKeys(payload, ["schemaVersion", "scope", "buffers", "selected"])
      || payload.schemaVersion !== 1 || !validScope(payload.scope)
      || payload.scope.sessionId !== scope.sessionId || payload.scope.cwd !== scope.cwd
      || !isRecord(payload.buffers)) return invalid;
    if (Object.hasOwn(payload, "selected") && (typeof payload.selected !== "string" || !validPath(payload.selected))) return invalid;
    const paths = Object.keys(payload.buffers).sort();
    if (paths.length === 0) return invalid;
    const buffers: Record<string, RestoredBuffer> = {};
    for (const path of paths) {
      const buffer = payload.buffers[path];
      if (!validPath(path) || !validStoredBuffer(buffer)) return invalid;
      buffers[path] = { content: buffer.content, saved: buffer.saved, version: buffer.version, source: "human" };
    }
    const selected = typeof payload.selected === "string" && Object.hasOwn(buffers, payload.selected) ? payload.selected : paths[0]!;
    return { snapshot, buffers, selected };
  } catch { return invalid; }
}

export function writeDraftBackup(
  storage: DraftStorage | undefined,
  scope: DraftScope,
  buffers: Readonly<Record<string, DraftBuffer>>,
  selected: string | undefined,
  expectedSnapshot: string | null
): BackupWrite {
  if (storage === undefined) return { snapshot: expectedSnapshot, error: "unavailable" };
  const key = draftBackupKey(scope);
  let previous: string | null;
  try { previous = storage.getItem(key); }
  catch { return { snapshot: expectedSnapshot, error: "unavailable" }; }
  // Keep the old expectation after a conflict so a later autosave cannot overwrite another page.
  if (previous !== expectedSnapshot) return { snapshot: expectedSnapshot, error: "changed" };
  try {
    if (!validScope(scope)) return { snapshot: expectedSnapshot, error: "write-failed" };
    const stored: Record<string, StoredBuffer> = {};
    for (const path of Object.keys(buffers).sort()) {
      const buffer = buffers[path];
      if (!isDirtyDraft(buffer)) continue;
      if (buffer === undefined || !validPath(path)) return { snapshot: expectedSnapshot, error: "write-failed" };
      const core = { content: buffer.content, saved: buffer.saved, version: buffer.version };
      if (!validStoredBuffer(core)) return { snapshot: expectedSnapshot, error: "write-failed" };
      stored[path] = core;
    }
    const paths = Object.keys(stored);
    const snapshot = paths.length === 0 ? null : JSON.stringify({
      schemaVersion: 1,
      scope: { sessionId: scope.sessionId, cwd: scope.cwd },
      buffers: stored,
      selected: selected !== undefined && Object.hasOwn(stored, selected) ? selected : paths[0]
    });
    if (snapshot === previous) return { snapshot };
    if (snapshot === null) storage.removeItem(key);
    else storage.setItem(key, snapshot);
    return { snapshot };
  } catch { return { snapshot: expectedSnapshot, error: "write-failed" }; }
}
