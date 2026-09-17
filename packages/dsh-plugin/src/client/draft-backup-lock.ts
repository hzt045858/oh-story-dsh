import { draftBackupKey, type DraftScope } from "./draft-backup.js";

const owners = new Map<string, symbol>();

export function hasDraftBackupLock(scope: DraftScope): boolean {
  return owners.has(draftBackupKey(scope));
}

export function acquireDraftBackupLock(
  scope: DraftScope,
  onResult: (result: "owned" | "busy" | "unavailable") => void
): () => void {
  const key = draftBackupKey(scope);
  const token = Symbol(key);
  let active = true;
  let releaseLock: (() => void) | undefined;
  const release = (): void => {
    if (owners.get(key) === token) owners.delete(key);
    releaseLock?.();
    releaseLock = undefined;
  };
  const cleanup = (): void => {
    active = false;
    release();
  };
  const unavailable = (): void => {
    if (!active) return;
    cleanup();
    onResult("unavailable");
  };
  try {
    const locks = globalThis.navigator?.locks;
    if (typeof locks?.request !== "function") {
      unavailable();
      return cleanup;
    }
    void locks.request(key, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!active) return;
      if (lock === null) {
        onResult("busy");
        return;
      }
      // Keep the browser lock alive for the editor's lifetime, not just one storage write.
      const held = new Promise<void>((resolve) => { releaseLock = resolve; });
      owners.set(key, token);
      try {
        onResult("owned");
        await held;
      } finally { release(); }
    }).catch(unavailable);
  } catch { unavailable(); }
  return cleanup;
}
