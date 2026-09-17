import { describe, expect, it } from "vitest";
import {
  applyProductionDocumentResults,
  productionDocumentRequests,
  type ProductionDocumentBuffer
} from "../src/client/production-documents.js";

function buffer(content: string, version: string): ProductionDocumentBuffer {
  return { content, saved: content, source: "disk", version };
}

describe("production document refresh", () => {
  it("reloads missing and changed documents while excluding the selected, active and saving files", () => {
    const paths = ["missing.md", "stale.md", "fresh.md", "selected.md", "active.md", "saving.md", "settled-agent.md"];
    expect(productionDocumentRequests(paths, paths.map((path) => ({ path, version: "new" })), {
      "stale.md": buffer("Old prompt", "old"),
      "fresh.md": buffer("Current prompt", "new"),
      "saving.md": { ...buffer("Saving prompt", "old"), saving: true },
      "settled-agent.md": { ...buffer("Streaming preview", "new"), source: "agent" }
    }, new Set(["selected.md", "active.md"]))).toEqual([
      { path: "missing.md", previousVersion: undefined },
      { path: "stale.md", previousVersion: "old" },
      { path: "settled-agent.md", previousVersion: "new" }
    ]);
  });

  it("keeps successful refreshes when another document fails without inventing an empty document", () => {
    const next = applyProductionDocumentResults({ "failed.md": buffer("Existing prompt", "old") }, [
      { path: "success.md", previousVersion: undefined },
      { path: "failed.md", previousVersion: "old" },
      { path: "unread.md", previousVersion: undefined }
    ], [
      { status: "fulfilled", value: { path: "success.md", content: "New prompt", version: "new" } },
      { status: "rejected", reason: new Error("HTTP 500") },
      { status: "rejected", reason: new Error("HTTP 403") }
    ]);
    expect(next["success.md"]).toEqual(buffer("New prompt", "new"));
    expect(next["failed.md"]).toEqual({ ...buffer("Existing prompt", "old"), error: "HTTP 500" });
    expect(next["unread.md"]).toBeUndefined();
  });

  it("preserves edits made during loading and exposes the changed disk version as a conflict", () => {
    const edited: ProductionDocumentBuffer = { ...buffer("Original prompt", "old"), content: "My edited prompt", source: "human" };
    const next = applyProductionDocumentResults({ "prompt.md": edited }, [{ path: "prompt.md", previousVersion: "old" }], [
      { status: "fulfilled", value: { path: "prompt.md", content: "Changed on disk", version: "new" } }
    ]);
    expect(next["prompt.md"]).toMatchObject({
      content: "My edited prompt", saved: "Original prompt", source: "human", version: "old",
      conflict: { theirs: "Changed on disk", theirsVersion: "new" }
    });
  });

  it("does not create a conflict when a dirty buffer still matches the disk base", () => {
    const edited: ProductionDocumentBuffer = { ...buffer("Original prompt", "old"), content: "My edited prompt", source: "human", error: "Previous failure" };
    const next = applyProductionDocumentResults({ "prompt.md": edited }, [{ path: "prompt.md", previousVersion: "old" }], [
      { status: "fulfilled", value: { path: "prompt.md", content: "Original prompt", version: "old" } }
    ]);
    expect(next["prompt.md"]).toMatchObject({ content: "My edited prompt", saved: "Original prompt", source: "human" });
    expect(next["prompt.md"]?.conflict).toBeUndefined();
    expect(next["prompt.md"]?.error).toBeUndefined();
  });

  it("ignores late responses and failures after another read or save advances the buffer", () => {
    const current = {
      "advanced.md": buffer("Latest saved prompt", "latest"),
      "saving.md": { ...buffer("Save in progress", "old"), saving: true }
    };
    const requests = [
      { path: "advanced.md", previousVersion: "old" },
      { path: "saving.md", previousVersion: "old" }
    ];
    const success = applyProductionDocumentResults(current, requests, requests.map(({ path }) => ({
      status: "fulfilled", value: { path, content: "Stale response", version: "new" }
    })));
    const failure = applyProductionDocumentResults(current, requests, requests.map(() => ({ status: "rejected", reason: new Error("Old failure") })));
    expect(success).toBe(current);
    expect(failure).toBe(current);
  });
});
