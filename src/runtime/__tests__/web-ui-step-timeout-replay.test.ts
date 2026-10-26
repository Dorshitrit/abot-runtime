import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module.
import { createStepTimeoutFeature } from "../../web-ui/app/step-timeout-feature.js";
import { bindContextReplayEvents, captureContextReplayScope } from "../../web-ui/app/lib/context-window-replay.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

// Persisted runtime events intentionally contain neither environment nor sessionId.
const timeout = {
  type: "event", name: "model.step.timed_out", requestId: "request-1",
  invocationId: "request-1:context.compact:2", modelStep: "context.compact",
  configurationProfileId: "chat-profile", profileId: "chat-profile",
  calibrationSlotId: "context.compact", provider: "ollama", model: "chat-model",
  timeoutMs: 300_000, configuredTimeoutMs: 180_000,
  timeoutSource: "model_calibration", seqNo: 51, eventSequence: 51,
};
const suggestion = {
  ...timeout, canIncrease: true, proposedTimeoutMs: 600_000, revision: "current",
};

function fixture(status = "failed", fromHttpReplay = false) {
  let environment = "dev";
  const request = {
    requestId: "request-1", sessionId: "session-1", status,
    lifecycle: { schemaVersion: 1, requestId: "request-1", status, generation: "original", revision: 1 },
    events: fromHttpReplay ? [] : [timeout],
  };
  const h = createPlanLifecycleHarness({
    title: "Conversation", messages: [{
      id: "answer", role: "assistant", requestId: "request-1", text: "The original answer.",
    }], requests: [request],
  }, fromHttpReplay ? [timeout] : [], () => environment);
  const state = Object.assign(h.state, { config: { backend: "runtime" } });
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.body = document.createElement("body");
  document.activeElement = document.body;
  vi.stubGlobal("document", document);
  const client = {
    inspectStepTimeout: vi.fn(async (_identity: unknown) => ({ ok: true, suggestion })),
    increaseStepTimeout: vi.fn(async () => ({ ok: true })),
    applyRuntimeConfiguration: vi.fn(async () => ({ activation: { status: "ready" } })),
  };
  const feature = createStepTimeoutFeature({
    state, client, getEnvironmentId: () => environment, onApplied: vi.fn(),
    shell: { activeWorkspace: () => "chat", subscribeWorkspaceChange: vi.fn(), activateWorkspace: vi.fn() },
  });
  // The application routes socket and HTTP replay through handle, and settled
  // snapshot history through recordEvent. Exercise both real controller paths.
  const originalHandle = h.realtime.handle;
  const originalRecord = h.realtime.recordEvent;
  vi.spyOn(h.realtime, "handle").mockImplementation((message) => {
    originalHandle(message);
    void feature.handleEvent(message);
  });
  vi.spyOn(h.realtime, "recordEvent").mockImplementation((message) => {
    originalRecord(message);
    void feature.handleEvent(message);
  });
  const originalRender = h.renderMessages.getMockImplementation()!;
  h.renderMessages.mockImplementation(() => { feature.syncScope(); originalRender(); });
  return {
    ...h, state, client, feature, document,
    notice: () => document.body.querySelector(".step-timeout-notice")!,
    setEnvironment(value: string) { environment = value; feature.syncScope(); },
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("timeout suggestions from trusted conversation replay", () => {
  test("settled snapshot restores the passive notice without changing the saved answer", async () => {
    const f = fixture();
    await f.conversationSession.openSession("session-1");
    await vi.waitFor(() => expect(f.notice().hidden).toBe(false));
    expect(f.client.inspectStepTimeout).toHaveBeenCalledExactlyOnceWith({
      environment: "dev", sessionId: "session-1", requestId: "request-1", invocationId: timeout.invocationId,
    });
    expect(f.state.messages.map((message) => message.text)).toEqual(["The original answer."]);
    expect(f.state.events).toEqual([]);
    expect(f.state.lastSeqByRequest.get("request-1")).toBe(51);
    expect(f.client.increaseStepTimeout).not.toHaveBeenCalled();
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
  });

  test("active HTTP replay exposes the same scoped receipt before socket resume", async () => {
    const f = fixture("streaming", true);
    await f.conversationSession.openSession("session-1");
    await vi.waitFor(() => expect(f.notice().hidden).toBe(false));
    expect(f.client.inspectStepTimeout).toHaveBeenCalledOnce();
    expect(f.sendRealtime).toHaveBeenCalledWith({
      type: "resume_request", requestId: "request-1", afterSeq: 51, environment: "dev",
    });
    expect(f.state.lastSeqByRequest.get("request-1")).toBe(51);
  });

  test.each(["failed", "streaming"])("socket/replay duplicates never reopen a dismissed %s receipt", async (status) => {
    const f = fixture(status, status === "streaming");
    await f.conversationSession.openSession("session-1");
    await vi.waitFor(() => expect(f.notice().hidden).toBe(false));
    f.document.body.querySelector(".step-timeout-dismiss")!.dispatch("click");
    f.realtime.handle({ ...timeout, environment: "dev", sessionId: "session-1" });
    await f.conversationSession.rehydrateRequests([{ requestId: "request-1", status: "failed", events: [timeout] }]);
    expect(f.client.inspectStepTimeout).toHaveBeenCalledOnce();
    expect(f.notice().hidden).toBe(true);
  });

  test.each(["clear", "navigate"])("%s invalidates pending inspection from the real snapshot path", async (action) => {
    const f = fixture();
    let resolve!: (value: { ok: boolean; suggestion: typeof suggestion }) => void;
    f.client.inspectStepTimeout.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await f.conversationSession.openSession("session-1");
    expect(f.client.inspectStepTimeout).toHaveBeenCalledOnce();
    if (action === "clear") f.conversationSession.clearSessionMessagesView();
    else f.conversationSession.clearCurrentSessionView();
    resolve({ ok: true, suggestion });
    await Promise.resolve(); await Promise.resolve();
    expect(f.notice().hidden).toBe(true);
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
  });

  test("unbound persisted-looking events remain rejected", async () => {
    const f = fixture();
    await f.feature.handleEvent(timeout);
    expect(f.client.inspectStepTimeout).not.toHaveBeenCalled();
  });

  test.each(["inspection", "save"])("generation replacement during pending %s invalidates the replay receipt", async (phase) => {
    const f = fixture();
    let resolve!: (value: any) => void;
    if (phase === "inspection") {
      f.client.inspectStepTimeout.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    }
    await f.conversationSession.openSession("session-1");
    if (phase === "save") {
      await vi.waitFor(() => expect(f.notice().hidden).toBe(false));
      f.client.increaseStepTimeout.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
      f.document.body.querySelector("[data-timeout-increase]")!.dispatch("click");
      await vi.waitFor(() => expect(f.client.increaseStepTimeout).toHaveBeenCalledOnce());
    }
    f.realtime.handle({
      type: "event", name: "request.lifecycle.changed", environment: "dev", sessionId: "session-1",
      requestId: "request-1", lifecycle: {
        schemaVersion: 1, requestId: "request-1", status: "streaming", generation: "replacement", revision: 1,
      },
    });
    expect(f.state.requestLifecycles?.get("request-1")?.generation).toBe("replacement");
    resolve({ ok: true, suggestion });
    await Promise.resolve(); await Promise.resolve();
    expect(f.client.applyRuntimeConfiguration).not.toHaveBeenCalled();
    expect(f.notice().hidden).toBe(true);
  });

  test.each(["environment", "view", "generation", "request"])("rejects a stale or mismatched replay %s binding", async (change) => {
    const f = fixture();
    f.state.requestLifecycles = new Map([["request-1", { generation: "original" }]]);
    const scope = captureContextReplayScope(f.state, "dev", "request-1");
    const [bound] = bindContextReplayEvents([timeout], scope);
    if (change === "environment") f.setEnvironment("prod");
    if (change === "view") f.conversationSession.clearSessionMessagesView();
    if (change === "generation") f.state.requestLifecycles.set("request-1", { generation: "replacement" });
    const event = change === "request" ? { ...bound, requestId: "other-request" } : bound;
    await f.feature.handleEvent(event);
    expect(f.client.inspectStepTimeout).not.toHaveBeenCalled();
    expect(f.notice().hidden).toBe(true);
  });
});
