import { describe, expect, test, vi } from "vitest";

import { createComposerSubmitController } from "../../web-ui/app/controllers/composer-submit-controller.js";

function createPendingSubmission() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSubmitHarness() {
  const pending = createPendingSubmission();
  let environmentId = "dev";
  let visible = true;
  const state = {
    currentSessionId: "old-chat",
    sessionViewVersion: 1,
    activeRequestId: "",
    pendingAttachments: [],
    composerSending: false,
  };
  const input = {
    value: "Old request",
    style: { height: "" },
    scrollHeight: 48,
    focus: vi.fn(),
  };
  const appendRequestError = vi.fn();
  const setMessageStatus = vi.fn();
  const sendMessage = vi.fn(() => pending.promise);
  const controller = createComposerSubmitController({
    state,
    dom: { composerInput: input },
    composerActions: {
      primaryAction: () => "send",
      render: vi.fn(),
    },
    attachments: { activeUploadCount: () => 0 },
    queue: {
      enqueue: async () => {},
      isCurrentDraining: () => false,
      queuedCount: () => 0,
      restoreText: vi.fn(),
    },
    steer: async () => {},
    chatRequests: { sendMessage },
    conversationSession: { appendRequestError },
    selectedEnvironmentId: () => environmentId,
    setMessageStatus,
    isComposerVisible: () => visible,
  });
  return {
    controller, state, input, pending, appendRequestError,
    setMessageStatus, sendMessage,
    setEnvironment(value: string) { environmentId = value; },
    setVisible(value: boolean) { visible = value; },
  };
}

async function finishMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("web ui pending composer submission ownership", () => {
  test.each(["session", "environment", "view"] as const)(
    "keeps a new send busy when an old HTTP request fails after changing %s",
    async (scope) => {
      const harness = createSubmitHarness();
      harness.controller.dispatch();
      expect(harness.state.composerSending).toBe(true);
      if (scope === "session") harness.state.currentSessionId = "home-created-chat";
      if (scope === "environment") harness.setEnvironment("prod");
      if (scope === "view") harness.state.sessionViewVersion += 1;
      harness.state.composerSending = true;
      harness.input.value = "New conversation draft";

      harness.pending.reject(new Error("Old transport failure"));
      await finishMicrotasks();

      expect(harness.state.composerSending).toBe(true);
      expect(harness.appendRequestError).not.toHaveBeenCalled();
      expect(harness.setMessageStatus).not.toHaveBeenCalledWith("ABot request failed.");
      expect(harness.input.value).toBe("New conversation draft");
      expect(harness.input.focus).not.toHaveBeenCalled();
    },
  );

  test("binds completion to the session synchronously created by the request controller", async () => {
    const harness = createSubmitHarness();
    harness.state.currentSessionId = "";
    harness.sendMessage.mockImplementationOnce(() => {
      harness.state.currentSessionId = "created-chat";
      return harness.pending.promise;
    });

    harness.controller.dispatch();
    harness.pending.resolve();
    await finishMicrotasks();

    expect(harness.state.composerSending).toBe(false);
    expect(harness.input.focus).toHaveBeenCalledOnce();
  });

  test("reports failures for the same view and releases its busy state", async () => {
    const harness = createSubmitHarness();
    const error = new Error("Current request failed");
    harness.controller.dispatch();

    harness.pending.reject(error);
    await finishMicrotasks();

    expect(harness.appendRequestError).toHaveBeenCalledWith(error);
    expect(harness.state.composerSending).toBe(false);
  });

  test("settles a background Chat request without focusing Home", async () => {
    const harness = createSubmitHarness();
    harness.controller.dispatch();
    harness.setVisible(false);

    harness.pending.resolve();
    await finishMicrotasks();

    expect(harness.state.composerSending).toBe(false);
    expect(harness.input.focus).not.toHaveBeenCalled();
  });
});
