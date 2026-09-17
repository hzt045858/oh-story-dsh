import type { WorkbenchMode } from "./file-activity.js";

export interface WorkbenchEntryRequest {
  readonly sessionId: string;
  readonly mode: WorkbenchMode;
}

export interface WorkbenchEntryHost {
  pickDirectory: () => Promise<string | null>;
  createWorkspace: (input: { readonly path: string }) => Promise<{ readonly workspaceId: string }>;
  connectWorkspace: (workspaceId: string) => Promise<string>;
  openSession: (sessionId: string) => void;
}

/** Publish the chosen mode before navigation, including when DSH reuses a blank session. */
export async function enterWorkbench(
  host: WorkbenchEntryHost,
  mode: WorkbenchMode,
  publish: (request: WorkbenchEntryRequest) => void
): Promise<void> {
  const path = await host.pickDirectory();
  if (path === null) return;
  const workspace = await host.createWorkspace({ path });
  const sessionId = await host.connectWorkspace(workspace.workspaceId);
  publish({ sessionId, mode });
  host.openSession(sessionId);
}
