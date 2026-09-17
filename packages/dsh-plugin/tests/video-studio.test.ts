import { describe, expect, it } from "vitest";
import { videoArtifactSelection, videoPreviewSelection, type VideoArtifactSummary, type VideoPreviewAsset, type VideoProject } from "../src/client/video-studio.js";

function project(previews: readonly VideoPreviewAsset[] = [], artifacts: readonly VideoArtifactSummary[] = []): VideoProject {
  return { id: "recap", root: "video-recaps/recap", title: "Recap", state: "working", stage: "analysis", stageLabel: "Analysis", previews, artifacts };
}

const source: VideoPreviewAsset = { role: "source", label: "Source", path: "video-recaps/recap/sources/source.mp4", bytes: 100, version: "v1", mimeType: "video/mp4" };
const final: VideoPreviewAsset = { ...source, role: "final", label: "Final", path: "video-recaps/recap/output/final.mp4" };
const script: VideoArtifactSummary = { label: "Script", path: "video-recaps/recap/work/narration.json", version: "v1", kind: "script" };
const quality: VideoArtifactSummary = { label: "Quality", path: "video-recaps/recap/work/final_qc.json", version: "v1", kind: "quality" };

describe("video workbench selection", () => {
  it("makes the first preview available after an initially empty project", () => {
    expect(videoPreviewSelection(project(), undefined, undefined).loaded).toBeUndefined();
    const next = videoPreviewSelection(project([source]), undefined, undefined);
    expect(next.selected).toBe(source);
    expect(next.loaded).toBe(source);
  });

  it("retains the accepted playback version when files change or temporarily disappear", () => {
    const newer = { ...source, version: "v2" };
    const next = videoPreviewSelection(project([newer, final]), "source", source);
    expect(next.selected).toBe(newer);
    expect(next.loaded).toBe(source);
    expect(videoPreviewSelection(project([final]), "source", source).loaded).toBe(source);
    expect(videoPreviewSelection(project(), "source", source).loaded).toBe(source);
  });

  it("selects the first artifact when it arrives and falls back when selection disappears", () => {
    expect(videoArtifactSelection(project(), undefined)).toBeUndefined();
    expect(videoArtifactSelection(project([], [script]), undefined)).toBe(script);
    expect(videoArtifactSelection(project([], [quality]), script.path)).toBe(quality);
    expect(videoArtifactSelection(project(), script.path)).toBeUndefined();
  });

  it("preserves a valid selection and exposes its current file version", () => {
    const revised = { ...script, version: "v2" };
    expect(videoArtifactSelection(project([], [revised, quality]), script.path)).toBe(revised);
    expect(videoArtifactSelection(project([], [revised, quality]), undefined)).toBe(quality);
  });
});
