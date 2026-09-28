import { afterEach, expect, test, vi } from "vitest";
import { createComposerStopController } from "../../web-ui/app/controllers/composer-stop-controller.js";
// @ts-expect-error Browser JavaScript module.
import { restoreStoppedResponses, isStoppedRequest } from "../../web-ui/app/lib/request-stop-state.js";
import {
  eventTone,
  formatEventDetail,
  formatEventLabel,
} from "../../web-ui/app/lib/event-presentation.js";
import { createComposerWorkspaceHarness } from "./support/web-ui-composer-workspace-harness.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";
import { createComposerActions } from "../../web-ui/app/components/composer-actions.js";

afterEach(() => vi.unstubAllGlobals());

function stopHarness() {
  const state = { activeRequestId: "request", currentSessionId: "session" };
  const stopRequest = vi.fn(async (_scope: unknown) => ({ accepted: true }));
  const setMessageStatus = vi.fn();
  const controller = createComposerStopController({
    state,
    stopRequest,
    setMessageStatus,
    selectedEnvironmentId: () => "dev",
    updateSendState: vi.fn(),
  });
  return { state, stopRequest, setMessageStatus, controller };
}

test("Stop waits for the terminal event, ignores duplicate clicks, and allows the next request", async () => {
  const h = stopHarness();
  await h.controller.stop();
  await h.controller.stop();
  expect(h.stopRequest).toHaveBeenCalledExactlyOnceWith({
    environmentId: "dev",
    sessionId: "session",
    requestId: "request",
  });
  expect(h.controller.isStopping()).toBe(true);
  expect(h.state.activeRequestId).toBe("request");
  h.state.activeRequestId = "";
  expect(h.controller.isStopping()).toBe(false);
  h.state.activeRequestId = "next";
  await h.controller.stop();
  expect(h.stopRequest).toHaveBeenCalledTimes(2);
});

test("a failed stop remains retryable and late errors cannot change a different conversation", async () => {
  const h = stopHarness();
  h.stopRequest.mockRejectedValueOnce(new Error("Network unavailable"));
  await h.controller.stop();
  expect(h.controller.isStopping()).toBe(false);
  expect(h.state.activeRequestId).toBe("request");
  let reject!: (error: Error) => void;
  h.stopRequest.mockImplementationOnce(
    () =>
      new Promise((_resolve, failed) => {
        reject = failed;
      }),
  );
  const pending = h.controller.stop();
  h.state.currentSessionId = "other-session";
  h.setMessageStatus.mockClear();
  reject(new Error("late failure"));
  await pending;
  expect(h.setMessageStatus).not.toHaveBeenCalled();
  expect(h.controller.isStopping()).toBe(false);
});

test("Stop stays available with no draft, uploads or send-next attachments", () => {
  const element = () => ({
    disabled: false,
    hidden: false,
    title: "",
    textContent: "",
    dataset: {},
    classList: { toggle: vi.fn() },
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
  });
  const stopButton = element();
  const onStop = vi.fn();
  const actions = createComposerActions({
    dom: {
      stopButton,
      composerForm: element(),
      composerSubmitControl: element(),
      sendButton: element(),
      sendButtonLabel: element(),
      sendNextMenuButton: element(),
      sendNextMenu: element(),
      sendNextButton: element(),
    } as never,
    documentRoot: { addEventListener: vi.fn() } as never,
    onSendNext: vi.fn(),
  });
  actions.bind();
  actions.render({
    activeRequestId: "request",
    disabled: true,
    busy: true,
    attachmentCount: 2,
    onStop,
  });
  expect(stopButton.disabled).toBe(false);
  expect(stopButton.hidden).toBe(false);
  stopButton.addEventListener.mock.calls[0][1]();
  expect(onStop).toHaveBeenCalledOnce();
  actions.render({ activeRequestId: "request", stopping: true });
  expect(stopButton.disabled).toBe(true);
  expect(stopButton.hidden).toBe(false);
  actions.render({ activeRequestId: "" });
  expect(stopButton.disabled).toBe(true);
  expect(stopButton.hidden).toBe(true);
});

test("stopping pauses Send next and restores its draft and attachments exactly once", async () => {
  const h = createComposerWorkspaceHarness();
  const scope = { environmentId: "dev", sessionId: "existing-chat" };
  await h.queue.enqueue("Queued follow-up");
  await h.queue.drain({
    ...scope,
    terminalRequestId: "existing-request",
    cancelled: true,
  });
  expect(h.client.postChatMessage).not.toHaveBeenCalled();
  expect(h.dom.composerInput.value).toBe(
    "Queued follow-up\nExisting chat draft",
  );
  expect(h.state.pendingAttachments.map((entry) => entry.id)).toEqual([
    "chat-file",
  ]);
  expect(h.onControlEvent).toHaveBeenLastCalledWith(
    expect.objectContaining({ tone: "neutral" }),
  );
  expect(h.sessionQueue.getBlockedRelease(scope)).toBeTruthy();
  expect(h.queue.recoverForManualSend(scope)).toBe(false);
  await h.queue.drain({
    ...scope,
    terminalRequestId: "existing-request",
    cancelled: true,
  });
  expect(h.dom.composerInput.value).toBe(
    "Queued follow-up\nExisting chat draft",
  );
});

test("a stopped partial response survives reload without becoming an error or a duplicate", () => {
  const failed = { type: "failed", error: "request_cancelled" };
  const request = {
    requestId: "request",
    status: "failed",
    updatedAt: "now",
    events: [
      { payload: { type: "token", text: "Partial" } },
      { payload: { type: "token", text: "Partial answer" } },
      { payload: failed },
    ],
  };
  const messages = [{ role: "user", text: "Question", requestId: "request" }];
  expect(isStoppedRequest(request)).toBe(true);
  restoreStoppedResponses(messages, [request]);
  restoreStoppedResponses(messages, [request]);
  expect(messages).toHaveLength(2);
  expect(messages[1].text).toBe("Partial answer\n\n_Response stopped._");
  expect(eventTone(failed)).toBe("neutral");
  expect(formatEventLabel(failed)).toBe("Response stopped");
  expect(formatEventDetail(failed)).not.toContain("request_cancelled");
});

test("reconnecting during Stop replays the active request and releases the composer", async () => {
  const h = createPlanLifecycleHarness();
  const controller = createComposerStopController({
    state: h.state,
    selectedEnvironmentId: () => "dev",
    stopRequest: async () => ({ accepted: true }),
    updateSendState: vi.fn(),
    setMessageStatus: vi.fn(),
  });
  h.state.lastSeqByRequest.set("request-1", 17);
  await controller.stop();
  expect(controller.isStopping()).toBe(true);
  h.conversationSession.subscribeSession("session-1");
  expect(h.sendRealtime).toHaveBeenLastCalledWith({
    type: "resume_request",
    requestId: "request-1",
    environment: "dev",
    afterSeq: 17,
  });
  const terminal = {
    type: "failed",
    requestId: "request-1",
    sessionId: "session-1",
    environment: "dev",
    error: "request_cancelled",
    seqNo: 18,
  };
  h.realtime.handle(terminal);
  h.realtime.handle(terminal);
  expect(h.state.activeRequestId).toBe("");
  expect(controller.isStopping()).toBe(false);
  expect(h.drainQueuedComposerMessage).toHaveBeenCalledExactlyOnceWith({
    environmentId: "dev",
    sessionId: "session-1",
    terminalRequestId: "request-1",
    cancelled: true,
  });
  h.sendRealtime.mockClear();
  h.conversationSession.subscribeSession("session-1");
  expect(h.sendRealtime).toHaveBeenCalledExactlyOnceWith({
    type: "subscribe_session",
    sessionId: "session-1",
    environment: "dev",
  });
});

test("a persisted stop response is identical live and after reload", () => {
  const h = createPlanLifecycleHarness();
  const output = "Partial answer.\n\nCancellation acknowledgement.";
  h.realtime.handle({
    type: "failed",
    requestId: "request-1",
    sessionId: "session-1",
    environment: "dev",
    error: "request_cancelled",
    seqNo: 18,
    details: { stoppedResponse: output },
  });
  expect(
    h.state.messages.filter((message) => message.role === "assistant"),
  ).toEqual([expect.objectContaining({ text: output, streaming: false })]);
  restoreStoppedResponses(h.state.messages, [
    {
      requestId: "request-1",
      status: "failed",
      finalState: { error: "request_cancelled" },
    },
  ]);
  expect(
    h.state.messages.filter((message) => message.role === "assistant"),
  ).toHaveLength(1);
  expect(h.state.activeRequestId).toBe("");
});

test("a realtime stop terminal preserves queued drafts instead of sending the next request", async () => {
  const h = createPlanLifecycleHarness();
  const q = createComposerWorkspaceHarness();
  await q.queue.enqueue("Keep this draft");
  h.state.currentSessionId = q.state.currentSessionId;
  h.state.activeRequestId = q.state.activeRequestId;
  h.drainQueuedComposerMessage.mockImplementation((scope) =>
    q.queue.drain(scope),
  );
  h.realtime.handle({
    type: "failed",
    requestId: q.state.activeRequestId,
    sessionId: q.state.currentSessionId,
    environment: "dev",
    error: "request_cancelled",
  });
  await Promise.resolve();
  expect(q.dom.composerInput.value).toBe(
    "Keep this draft\nExisting chat draft",
  );
  expect(q.sessionQueue.getBlockedRelease(q.queue.currentScope())).toBeTruthy();
  expect(q.client.postChatMessage).not.toHaveBeenCalled();
});
