import { describe, expect, it, vi } from "vitest";
import { enterWorkbench, preparedCreationDraft, type WorkbenchEntryHost, type WorkbenchEntryRequest } from "../src/client/workbench-entry.js";

function host() {
  return {
    pickDirectory: vi.fn<WorkbenchEntryHost["pickDirectory"]>().mockResolvedValue("D:/stories"),
    createWorkspace: vi.fn<WorkbenchEntryHost["createWorkspace"]>().mockResolvedValue({ workspaceId: "workspace-test" }),
    connectWorkspace: vi.fn<WorkbenchEntryHost["connectWorkspace"]>().mockResolvedValue("session-test"),
    openSession: vi.fn<WorkbenchEntryHost["openSession"]>()
  };
}

describe("workbench entry", () => {
  it.each(["story", "drama", "game", "video", "wechat"] as const)("opens the chosen %s workbench in a real session", async (mode) => {
    const services = host();
    const requests: WorkbenchEntryRequest[] = [];
    services.openSession.mockImplementation((sessionId) => {
      expect(requests).toEqual([{ sessionId, mode }]);
    });

    await enterWorkbench(services, mode, (request) => { requests.push(request); });

    expect(services.createWorkspace).toHaveBeenCalledExactlyOnceWith({ path: "D:/stories" });
    expect(services.connectWorkspace).toHaveBeenCalledExactlyOnceWith("workspace-test");
    expect(services.openSession).toHaveBeenCalledExactlyOnceWith("session-test");
  });

  it("does not create or select a session when the directory picker is cancelled", async () => {
    const services = host();
    services.pickDirectory.mockResolvedValue(null);
    const publish = vi.fn();
    await enterWorkbench(services, "story", publish);
    expect(services.createWorkspace).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(services.openSession).not.toHaveBeenCalled();
  });

  it("surfaces a failed session creation without applying a mode to another session", async () => {
    const services = host();
    services.connectWorkspace.mockRejectedValue(new Error("workspace unavailable"));
    const publish = vi.fn();
    await expect(enterWorkbench(services, "video", publish)).rejects.toThrow("workspace unavailable");
    expect(publish).not.toHaveBeenCalled();
    expect(services.openSession).not.toHaveBeenCalled();
  });
});

describe("creation command preparation", () => {
  it.each([
    ["story", "/story-setup "], ["drama", "/short-drama "], ["wechat", "/wechat-article "]
  ] as const)("prepares the existing %s entry command for an empty composer", (mode, command) => {
    expect(preparedCreationDraft(mode, "")).toBe(command);
    expect(preparedCreationDraft(mode, " \n ")).toBe(command);
  });

  it.each(["/story-setup", "/story-setup ", "/short-drama", " /short-drama \n"])(
    "replaces the bare foreign placeholder %j only when starting a WeChat article", (draft) => {
      expect(preparedCreationDraft("wechat", draft)).toBe("/wechat-article ");
    }
  );

  it.each([
    "/story-setup Keep my story draft", "/story-setup\nUse my existing references",
    "/short-drama Write my episode", "Keep my own article request", "/wechat-article ", "/story-setup-extra"
  ])("preserves authored content and other commands: %j", (draft) => {
    expect(preparedCreationDraft("wechat", draft)).toBeUndefined();
  });

  it.each(["story", "drama", "game", "video"] as const)("does not change existing %s nonempty draft behavior", (mode) => {
    for (const draft of ["/story-setup ", "/short-drama ", "/wechat-article ", "Keep my draft"]) {
      expect(preparedCreationDraft(mode, draft)).toBeUndefined();
    }
  });
});
