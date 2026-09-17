import {
  draftBackupKey,
  draftBackupStorage,
  isDirtyDraft,
  readDraftBackup,
  writeDraftBackup,
  type DraftBuffer,
  type DraftScope,
  type DraftStorage
} from "./draft-backup.js";
import { hasDraftBackupLock } from "./draft-backup-lock.js";

export interface FileBuffer extends DraftBuffer {
  readonly saving?: boolean | undefined;
  readonly error?: string | undefined;
  readonly missing?: boolean | undefined;
  readonly conflict?: {
    readonly message: string;
    readonly theirs?: string | undefined;
    readonly theirsVersion?: string | undefined;
  } | undefined;
}

export interface DraftSessionState {
  buffers: Record<string, FileBuffer>;
  draftScope: DraftScope | undefined;
  draftSnapshot: string | null | undefined;
  draftError: "unavailable" | "invalid" | "changed" | "write-failed" | "busy" | undefined;
  recoveredDrafts: number;
  draftSessionReady?: boolean;
}

export function sameDraftScope(left: DraftScope | undefined, right: DraftScope): boolean {
  return left?.sessionId === right.sessionId && left.cwd === right.cwd;
}

export function persistDraftSession(state: DraftSessionState, selected: string | undefined, storage: DraftStorage | undefined): void {
  if (state.draftScope === undefined || state.draftSnapshot === undefined
    || state.draftError === "invalid" || state.draftError === "changed" || state.draftError === "busy") return;
  const result = writeDraftBackup(storage, state.draftScope, state.buffers, selected, state.draftSnapshot);
  state.draftSnapshot = result.snapshot;
  state.draftError = result.error;
}

// Restore before mounting editors. In-memory drafts and another page's divergent draft
// must never be silently replaced, including after a temporarily unavailable storage read.
export function restoreDraftSession(state: DraftSessionState, scope: DraftScope, storage: DraftStorage | undefined): string | undefined {
  const backup = readDraftBackup(storage, scope);
  if (state.draftScope !== undefined && !sameDraftScope(state.draftScope, scope)) {
    state.buffers = {};
    state.draftSnapshot = undefined;
    state.recoveredDrafts = 0;
    state.draftSessionReady = false;
  }
  state.draftScope = scope;
  if (backup.error !== undefined) {
    state.draftError = backup.error;
    return undefined;
  }
  if (backup.snapshot === state.draftSnapshot) {
    state.draftError = undefined;
    return undefined;
  }
  const collisions = Object.entries(backup.buffers).some(([path, buffer]) => {
    const local = state.buffers[path];
    return local !== undefined && isDirtyDraft(local)
      && (local.content !== buffer.content || local.saved !== buffer.saved || local.version !== buffer.version);
  });
  if (collisions) {
    state.draftError = "changed";
    return undefined;
  }
  let restored = 0;
  for (const [path, buffer] of Object.entries(backup.buffers)) {
    if (isDirtyDraft(state.buffers[path])) continue;
    state.buffers[path] = buffer;
    restored += 1;
  }
  state.draftSnapshot = backup.snapshot;
  state.draftError = undefined;
  state.recoveredDrafts = restored;
  return restored > 0 ? backup.selected : undefined;
}

export function checkDraftSession(state: DraftSessionState, storage: DraftStorage | undefined): void {
  if (state.draftScope === undefined) return;
  const backup = readDraftBackup(storage, state.draftScope);
  if (backup.error !== undefined) state.draftError = backup.error;
  else if (backup.snapshot !== state.draftSnapshot) state.draftError = "changed";
}

const unbackedScopes = new Set<string>();
function warnUnbackedDrafts(event: BeforeUnloadEvent): void {
  if (unbackedScopes.size > 0) event.preventDefault();
}

// Keep failed backups protected even when their Session editor is unmounted.
export function updateDraftUnloadGuard(state: DraftSessionState): void {
  if (state.draftScope === undefined) return;
  const key = draftBackupKey(state.draftScope);
  if ((state.draftError !== undefined || state.draftSnapshot === undefined || state.draftSessionReady === false) && Object.values(state.buffers).some(isDirtyDraft)) unbackedScopes.add(key);
  else unbackedScopes.delete(key);
  if (unbackedScopes.size > 0) globalThis.addEventListener("beforeunload", warnUnbackedDrafts);
  else globalThis.removeEventListener("beforeunload", warnUnbackedDrafts);
}

export function syncDraftSession(state: DraftSessionState, selected: string | undefined): void {
  if (state.draftScope !== undefined && !hasDraftBackupLock(state.draftScope)) {
    state.draftError ??= "busy";
  } else persistDraftSession(state, selected, draftBackupStorage());
  updateDraftUnloadGuard(state);
}
