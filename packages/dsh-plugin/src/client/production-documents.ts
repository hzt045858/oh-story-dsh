export interface ProductionDocumentBuffer {
  readonly content: string;
  readonly saved: string;
  readonly source: "disk" | "human" | "agent";
  readonly version: string;
  readonly saving?: boolean | undefined;
  readonly error?: string | undefined;
  readonly missing?: boolean | undefined;
  readonly conflict?: {
    readonly message: string;
    readonly theirs?: string | undefined;
    readonly theirsVersion?: string | undefined;
  } | undefined;
}

export interface ProductionDocumentRequest {
  readonly path: string;
  readonly previousVersion: string | undefined;
}

export interface LoadedProductionDocument {
  readonly path: string;
  readonly content: string;
  readonly version: string;
}

export function productionDocumentRequests(
  paths: readonly string[],
  files: readonly { readonly path: string; readonly version: string }[],
  buffers: Readonly<Record<string, ProductionDocumentBuffer>>,
  excluded: ReadonlySet<string>
): readonly ProductionDocumentRequest[] {
  const versions = new Map(files.map((file) => [file.path, file.version]));
  return paths.flatMap((path) => {
    const version = versions.get(path);
    const existing = buffers[path];
    if (version === undefined || excluded.has(path) || existing?.saving === true) return [];
    if (existing !== undefined && existing.version === version && existing.source !== "agent"
      && existing.missing !== true && existing.error === undefined) return [];
    return [{ path, previousVersion: existing?.version }];
  });
}

export function applyProductionDocumentResults(
  current: Record<string, ProductionDocumentBuffer>,
  requests: readonly ProductionDocumentRequest[],
  results: readonly PromiseSettledResult<LoadedProductionDocument>[]
): Record<string, ProductionDocumentBuffer> {
  let next = current;
  for (const [index, result] of results.entries()) {
    const request = requests[index];
    if (request === undefined) continue;
    const existing = current[request.path];
    // A save or another read may have advanced the buffer while this batch was in flight.
    if (existing?.saving === true || existing?.version !== request.previousVersion) continue;
    if (result.status === "rejected") {
      if (existing === undefined) continue;
      const reason: unknown = result.reason;
      next = { ...next, [request.path]: { ...existing, error: reason instanceof Error ? reason.message : String(reason) } };
      continue;
    }
    const file = result.value;
    if (existing?.source === "human" && existing.content !== existing.saved) {
      next = {
        ...next,
        [request.path]: {
          ...existing,
          missing: false,
          error: undefined,
          ...(existing.version === file.version ? {} : {
            conflict: {
              message: `${request.path} 已在磁盘上更新；你的本地草稿没有被覆盖。`,
              theirs: file.content,
              theirsVersion: file.version
            }
          })
        }
      };
      continue;
    }
    next = { ...next, [request.path]: { content: file.content, saved: file.content, source: "disk", version: file.version } };
  }
  return next;
}
