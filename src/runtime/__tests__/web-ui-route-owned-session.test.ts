import { describe, expect, test, vi } from "vitest";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("Web UI route-owned conversation loading", () => {
  test.each(["workspace navigation", "new conversation"])(
    "%s cancels a pending route without changing the background conversation",
    async (reason) => {
      const f = createPlanLifecycleHarness();
      const previousMessages = f.state.messages;
      const loading = deferred<Record<string, unknown>>();
      f.client.loadSession.mockReturnValueOnce(loading.promise);
      let routeCurrent = true;
      const commitRouteNavigation = vi.fn(() => true);
      const opening = f.conversationSession.openSession("session-2", {
        isRouteCurrent: () => routeCurrent,
        commitRouteNavigation,
      });

      expect(f.state.currentSessionId).toBe("session-1");
      expect(f.state.messages).toBe(previousMessages);
      if (reason === "workspace navigation") routeCurrent = false;
      else f.state.sessionViewVersion += 1;
      loading.resolve({ messages: [], requests: [] });
      await opening;

      expect(commitRouteNavigation).not.toHaveBeenCalled();
      expect(f.state.currentSessionId).toBe("session-1");
      expect(f.state.messages).toBe(previousMessages);
      expect(f.saveSessionPreference).not.toHaveBeenCalled();
      expect(f.clearPendingAttachments).not.toHaveBeenCalled();
      expect(f.suspendQueueRecovery).not.toHaveBeenCalled();
      expect(f.sendRealtime).not.toHaveBeenCalled();
    },
  );

  test("commits the route after loading and keeps ordinary opens eager", async () => {
    const f = createPlanLifecycleHarness();
    const loading = deferred<Record<string, unknown>>();
    f.client.loadSession.mockReturnValueOnce(loading.promise);
    const commitRouteNavigation = vi.fn(() => true);
    const opening = f.conversationSession.openSession("session-2", {
      isRouteCurrent: () => true,
      commitRouteNavigation,
    });
    expect(f.state.currentSessionId).toBe("session-1");
    expect(f.suspendQueueRecovery).not.toHaveBeenCalled();

    loading.resolve({
      title: "Loaded conversation",
      messages: [
        { id: "message-2", role: "assistant", text: "Loaded", requestId: "" },
      ],
      requests: [],
    });
    await opening;

    expect(commitRouteNavigation).toHaveBeenCalledOnce();
    expect(f.suspendQueueRecovery).toHaveBeenCalledOnce();
    expect(f.suspendQueueRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      commitRouteNavigation.mock.invocationCallOrder[0],
    );
    expect(f.state.currentSessionId).toBe("session-2");
    expect(f.state.messages.map((message) => message.id)).toEqual([
      "message-2",
    ]);
    expect(f.saveSessionPreference).toHaveBeenCalledWith("dev", "session-2");
    expect(f.sendRealtime).toHaveBeenCalledWith({
      type: "subscribe_session",
      sessionId: "session-2",
      environment: "dev",
    });

    const ordinaryLoading = deferred<Record<string, unknown>>();
    f.client.loadSession.mockReturnValueOnce(ordinaryLoading.promise);
    const ordinaryOpening = f.conversationSession.openSession("session-3");
    expect(f.state.currentSessionId).toBe("session-3");
    expect(f.saveSessionPreference).toHaveBeenLastCalledWith(
      "dev",
      "session-3",
    );
    ordinaryLoading.resolve({ messages: [], requests: [] });
    await ordinaryOpening;
  });

  test("a queue veto prevents route activation after loading", async () => {
    const f = createPlanLifecycleHarness();
    const previousMessages = f.state.messages;
    f.suspendQueueRecovery.mockReturnValueOnce(false);
    const commitRouteNavigation = vi.fn(() => true);

    await f.conversationSession.openSession("session-2", {
      isRouteCurrent: () => true,
      commitRouteNavigation,
    });

    expect(commitRouteNavigation).not.toHaveBeenCalled();
    expect(f.state.currentSessionId).toBe("session-1");
    expect(f.state.messages).toBe(previousMessages);
    expect(f.saveSessionPreference).not.toHaveBeenCalled();
    expect(f.sendRealtime).not.toHaveBeenCalled();
  });
});
