import { describe, expect, test, vi } from "vitest";
import {
  createConversationSessionController,
  type ConversationSessionState,
} from "../../web-ui/app/controllers/conversation-session-controller.js";
import { createRealtimeEventController } from "../../web-ui/app/controllers/realtime-event-controller.js";
import { createSessionRunSelection } from "../../web-ui/app/controllers/session-run-selection.js";

type RecordValue = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function selection(requestId: string, selectedAt: number, primaryProfileId = "smoke-model") {
  return { requestId, selectedAt, primaryProfileId, agentMode: "deep", rootModelSteps: ["execution.decision"], status: "completed" };
}

function selectionEvent(run: ReturnType<typeof selection>, extra: RecordValue = {}) {
  return { type: "event", name: "request.model.selected", seqNo: 1, ...run, ...extra };
}

function snapshot(sessionId: string, modelSelection: RecordValue, requests: RecordValue[] = []) {
  return { sessionId, modelSelection, title: sessionId, messages: [], requests, nextCursor: null };
}

function createHydrationHarness(payload: RecordValue) {
  let environmentId = "dev";
  const state: ConversationSessionState = {
    currentSessionId: "", activeRequestId: "", sessionViewVersion: 0, messages: [], events: [],
    taskProgressByRequest: new Map(), contextWindowByRequest: new Map(), submittedToolApprovalIds: new Set(),
    requestMessages: new Map(), lastSeqByRequest: new Map(), sessions: [],
  };
  const getScope = () => ({ environmentId, sessionId: state.currentSessionId, viewVersion: state.sessionViewVersion });
  const observed = createSessionRunSelection({ getScope, getComposerScope: getScope });
  const onSessionSnapshot = vi.fn((value: RecordValue, scope: ReturnType<typeof getScope>) => observed.applySnapshot(value, scope));
  const onResetRunSelection = vi.fn(() => observed.clear());
  const client = {
    markSessionRead: vi.fn(async () => ({})), listSessions: vi.fn(async () => ({ sessions: [] })),
    loadSession: vi.fn(async (): Promise<RecordValue> => payload),
    fetchRequestEvents: vi.fn(async (): Promise<RecordValue[]> => []),
  };
  const conversation = createConversationSessionController({
    state, client, selectedEnvironmentId: () => environmentId,
    dom: { sessionTitle: { textContent: "" }, sessionsList: { innerHTML: "" } },
    preferences: { sessionIdForEnvironment: () => "", saveSessionIdForEnvironment: vi.fn() },
    sessions: { titleOf: () => "Saved", byId: () => undefined, setCurrentTitle: vi.fn(), applyTitle: vi.fn(), applyReadState: vi.fn() },
    sessionQueue: { peek: () => null, rebindBlocked: vi.fn() }, conversationView: { reset: vi.fn() },
    applyConversationChrome: vi.fn(), applyModelSelection: vi.fn(), onSessionSnapshot, onResetRunSelection,
    renderSessions: vi.fn(), renderMessages: vi.fn(), updateComposerSendState: vi.fn(), setMessageStatus: vi.fn(),
    sendRealtime: vi.fn(), handleRealtimeMessage: (event) => realtime.handle(event),
    recordEvent: (event) => realtime.recordEvent(event), recordControlEvent: vi.fn(), reportQueueFailure: vi.fn(),
    drainQueuedMessage: vi.fn(), suspendQueueRecovery: () => true, recoverBlockedQueue: vi.fn(),
    isCurrentComposerScope: () => true, scheduleTask: vi.fn(),
  });
  const observeRunEvent = vi.fn((event: RecordValue) => observed.observeEvent(event));
  const realtime = createRealtimeEventController({
    state, shell: { showToast: vi.fn() }, selectedEnvironmentId: () => environmentId,
    handleSteerAcknowledgement: () => false, shouldAcceptMessage: conversation.shouldAcceptRealtimeMessage,
    observeRunEvent, applySessionReadState: vi.fn(), activeAssistantForRequest: conversation.activeAssistantForRequest,
    addOrMergeMessage: conversation.addOrMergeMessage, normalizeChatMessage: conversation.normalizeMessage,
    renderMessages: vi.fn(), scheduleMessageRender: vi.fn(), scheduleThinkingRender: vi.fn(),
    cancelScheduledMessageRender: vi.fn(), cancelScheduledThinkingRender: vi.fn(), markCurrentSessionReadSoon: vi.fn(),
    applySessionTitleUpdate: vi.fn(), setMessageActivityStatus: vi.fn(), updateComposerSendState: vi.fn(),
    drainQueuedComposerMessage: vi.fn(), loadSessions: vi.fn(),
  });
  return { state, client, conversation, realtime, observed, onSessionSnapshot, observeRunEvent, onResetRunSelection,
    setEnvironment: (value: string) => { environmentId = value; } };
}

describe("request model selection across session hydration and realtime", () => {
  test("opening a historical target retains the authoritative latest run through older event replay", async () => {
    const latest = selection("latest", 2_000);
    const older = selection("older", 1_000, "historical-model");
    const payload = snapshot("smoke", latest, [{ requestId: "older", status: "completed", events: [selectionEvent(older)] }]);
    const h = createHydrationHarness(payload);

    expect(await h.conversation.openSession("smoke", { page: { targetRequestId: "older" } })).toBe(true);

    expect(h.observed.run()).toMatchObject(latest);
    expect(h.onSessionSnapshot).toHaveBeenCalledExactlyOnceWith(payload, { environmentId: "dev", sessionId: "smoke", viewVersion: h.state.sessionViewVersion });
    expect(h.onSessionSnapshot.mock.invocationCallOrder[0]).toBeLessThan(h.observeRunEvent.mock.invocationCallOrder[0]);
  });

  test("a latest request with unknown metadata cannot inherit the preceding request model", async () => {
    const h = createHydrationHarness(snapshot("smoke", { requestId: "unknown", selectedAt: 2_000 }, [
      { requestId: "older", status: "completed", events: [selectionEvent(selection("older", 1_000))] },
    ]));

    await h.conversation.openSession("smoke");

    expect(h.observed.run()).toMatchObject({ requestId: "unknown", selectedAt: 2_000 });
    expect(h.observed.run()?.primaryProfileId).toBeUndefined();
  });

  test("late session loads cannot overwrite a newly opened session's run", async () => {
    const stale = deferred<RecordValue>();
    const h = createHydrationHarness(snapshot("current", selection("current-run", 2_000)));
    h.client.loadSession.mockReturnValueOnce(stale.promise);
    const loadingOld = h.conversation.openSession("old");
    await vi.waitFor(() => expect(h.client.loadSession).toHaveBeenCalledOnce());
    await h.conversation.openSession("current");
    stale.resolve(snapshot("old", selection("stale-run", 3_000, "stale-model")));

    expect(await loadingOld).toBe(false);
    expect(h.observed.run()).toMatchObject({ requestId: "current-run", primaryProfileId: "smoke-model" });
    expect(h.onSessionSnapshot).toHaveBeenCalledOnce();
  });

  test("an environment change during load discards its model snapshot", async () => {
    const stale = deferred<RecordValue>();
    const h = createHydrationHarness({});
    h.client.loadSession.mockReturnValueOnce(stale.promise);
    const loading = h.conversation.openSession("same-id", { preserveCurrentWindow: true });
    h.setEnvironment("prod");
    stale.resolve(snapshot("same-id", selection("dev-run", 2_000)));

    expect(await loading).toBe(false);
    expect(h.onSessionSnapshot).not.toHaveBeenCalled();
    expect(h.observed.run()).toBeNull();
  });

  test("live normalized model events use the active session and context reasoning survives activity filtering", async () => {
    const h = createHydrationHarness(snapshot("smoke", selection("live", 1_000), [
      { requestId: "live", status: "streaming", events: [] },
    ]));
    await h.conversation.openSession("smoke");
    h.realtime.handle({ type: "event", name: "request.model.selected", requestId: "live", sessionId: "smoke", environment: "dev",
      payload: { ...selection("live", 2_000), status: "streaming" } });
    h.realtime.handle({ type: "event", name: "context.window.snapshot", requestId: "live", sessionId: "smoke", environment: "dev", seqNo: 2,
      payload: { profileId: "smoke-model", modelStep: "execution.decision", admissionOutcome: "accepted", reasoningEffort: "high" } });

    expect(h.observed.run()).toMatchObject({ requestId: "live", primaryProfileId: "smoke-model", effectiveReasoning: { reasoningEffort: "high" } });
    expect(h.state.events.some((event) => event.eventName === "context.window.snapshot")).toBe(false);
    h.realtime.handle(selectionEvent(selection("live", 3_000, "wrong-model"), { sessionId: "other-session", environment: "dev" }));
    h.realtime.handle(selectionEvent(selection("live", 3_000, "wrong-model"), { sessionId: "smoke", environment: "prod" }));
    expect(h.observed.run()?.primaryProfileId).toBe("smoke-model");
  });

  test("a new external request updates display metadata without adopting its execution or token stream", async () => {
    const h = createHydrationHarness(snapshot("smoke", selection("completed", 1_000)));
    await h.conversation.openSession("smoke");
    h.realtime.handle(selectionEvent(selection("external", 2_000, "app-model"), {
      sessionId: "smoke", environment: "dev", status: "streaming",
    }));
    h.realtime.handle({ type: "event", name: "context.window.snapshot", requestId: "external", sessionId: "smoke", environment: "dev", seqNo: 2,
      payload: { profileId: "app-model", modelStep: "execution.decision", admissionOutcome: "accepted", reasoningEffort: "high" } });
    h.realtime.handle({ type: "token", requestId: "external", sessionId: "smoke", environment: "dev", text: "unbound response" });

    expect(h.observed.run()).toMatchObject({ requestId: "external", primaryProfileId: "app-model", effectiveReasoning: { reasoningEffort: "high" } });
    expect(h.state.activeRequestId).toBe("");
    expect(h.state.requestMessages.size).toBe(0);
    expect(h.state.requestLifecycles?.size ?? 0).toBe(0);
    expect(h.state.messages).toEqual([]);
    expect(h.state.events).toEqual([]);

    for (const scope of [{ sessionId: "other", environment: "dev" }, { sessionId: "smoke", environment: "prod" }, {}]) {
      h.realtime.handle(selectionEvent(selection("unbound", 3_000, "wrong-model"), scope));
    }
    expect(h.observed.run()?.primaryProfileId).toBe("app-model");
  });

  test("clearing the conversation removes the observed run before the empty composer is rendered", async () => {
    const h = createHydrationHarness(snapshot("smoke", selection("latest", 2_000)));
    await h.conversation.openSession("smoke");

    h.conversation.clearCurrentSessionView();

    expect(h.state.currentSessionId).toBe("");
    expect(h.observed.run()).toBeNull();
    expect(h.onResetRunSelection).toHaveBeenCalledTimes(2);
  });
});
