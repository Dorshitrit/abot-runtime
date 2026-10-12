import { afterEach, describe, expect, test, vi } from "vitest";
import { createComposerProductionHarness } from "./support/composer-production-harness.js";

afterEach(() => vi.unstubAllGlobals());

describe("composer rendering before environment selection", () => {
  test("renders Home before configuration supplies an environment without reading a queue", () => {
    const h = createComposerProductionHarness();
    const blocked = vi.spyOn(h.sessionQueue, "getBlockedRelease");
    h.state.currentSessionId = "";
    h.setEnvironmentId("");

    expect(() => h.feature.setWorkspace("home")).not.toThrow();
    expect(h.workspace.homeDraft().scope).toEqual({ environmentId: "", sessionId: "home-session-1" });
    expect(blocked).not.toHaveBeenCalled();

    h.setEnvironmentId("prod");
    h.feature.environmentChanged();
    expect(blocked).toHaveBeenCalledWith(h.workspace.homeDraft().scope);
    expect(h.workspace.homeDraft().scope.environmentId).toBe("prod");
    expect(h.client.postChatMessage).not.toHaveBeenCalled();
  });

  test("defers Chat queue reads until both environment and conversation are selected", () => {
    const h = createComposerProductionHarness();
    h.enqueue("Keep this queued message");
    const list = vi.spyOn(h.sessionQueue, "list");
    const blocked = vi.spyOn(h.sessionQueue, "getBlockedRelease");
    h.setEnvironmentId("");

    expect(() => h.composer.render()).not.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(blocked).not.toHaveBeenCalled();
    expect(h.queue.queuedCount()).toBe(0);

    h.setEnvironmentId("dev");
    h.composer.render();
    expect(h.queue.queuedCount()).toBe(1);
    expect(h.sessionQueue.peek(h.workspace.chatDraft().scope)?.text).toBe("Keep this queued message");
    expect(h.client.postChatMessage).not.toHaveBeenCalled();
  });
});
