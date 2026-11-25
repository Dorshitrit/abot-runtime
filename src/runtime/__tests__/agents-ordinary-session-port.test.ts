import { expect, test, vi } from "vitest";
import type { SessionRecord, SessionRequestReplay } from "../../sessions/types.js";
import type { RuntimeRequestHandler } from "../composition.js";
import type { AgentWorkRequest } from "../agents/application-contracts.js";
import { createOrdinaryAgentSessionPort } from "../agents/ordinary-session-port.js";

const request: AgentWorkRequest = { agentId: "agent-a", missionId: "mission-a", attemptId: "attempt-a",
  requestId: "request-a", sessionId: "session-a", assignment: "Compare the supplied fictional notes.",
  modelProfileId: "selected-agent-model", toolPermissionMode: "ask" };
const session: SessionRecord = { id: request.sessionId, title: "Agent notes", createdAt: "2026-11-17T10:00:00.000Z",
  updatedAt: "2026-11-17T10:00:00.000Z", lastAgentMode: "reasoning", messageCount: 0, messages: [] };
function terminal(): SessionRequestReplay {
  return { requestId: request.requestId, sessionId: request.sessionId, generation: "generation-a",
    events: [{ type: "completed", requestId: request.requestId, seqNo: 1 }],
    finalState: { status: "completed", output: "Two fictional notes compared.", completedAt: 1 } };
}
function fixture() {
  const replay = { value: null as SessionRequestReplay | null };
  const sessions = {
    getOrCreateSession: vi.fn(async () => structuredClone(session)),
    getSessionById: vi.fn(async (): Promise<SessionRecord | null> => structuredClone(session)),
    getRequestReplayById: vi.fn(async () => replay.value),
  };
  const handle = vi.fn<RuntimeRequestHandler["handle"]>(async () => { replay.value = terminal(); });
  const cancel = vi.fn<NonNullable<RuntimeRequestHandler["cancel"]>>(async () => ({ accepted: true }));
  const list = vi.fn(async () => []);
  const decide = vi.fn(async () => ({ accepted: true as const }));
  const subscribeEvents = vi.fn(() => () => {});
  const requests: RuntimeRequestHandler = { handle, cancel,
    approvalControls: { list, decide, subscribeEvents, attach: async () => {} } };
  const onEvent = vi.fn();
  const port = createOrdinaryAgentSessionPort({ sessions, requests, onEvent });
  return { port, sessions, requests, handle, cancel, list, decide, subscribeEvents, onEvent, replay };
}

test("submits exactly one ordinary request with the Agent's model and existing options", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const result = await f.port.run(request, signal);
  expect(f.handle).toHaveBeenCalledOnce();
  const [, message, options] = f.handle.mock.calls[0];
  expect(message).toEqual({ type: "run_request", requestId: request.requestId, sessionId: request.sessionId,
    text: request.assignment, agentMode: "reasoning", modelPreference: { profileId: request.modelProfileId, scope: "all" }, toolPermissionMode: "ask" });
  expect(Object.keys(options!).sort()).toEqual(["abortSignal", "durableApprovals", "toolApprovalController"]);
  expect(options!.abortSignal).toBe(signal);
  expect(options!.durableApprovals).toBe(true);
  expect(result).toMatchObject({ status: "completed", output: "Two fictional notes compared.", usage: null });
  expect(f.sessions.getRequestReplayById).toHaveBeenCalledWith(request.requestId, 0, request.sessionId);
});

test("a transport failure after committed terminal work returns its receipt without replay", async () => {
  const f = fixture();
  f.handle.mockImplementationOnce(async () => { f.replay.value = terminal(); throw new Error("connection lost"); });
  expect(await f.port.run(request, new AbortController().signal)).toMatchObject({ status: "completed" });
  expect(f.handle).toHaveBeenCalledOnce();
});

test("missing outcome or failed inspection stays unknown and never invokes again", async () => {
  const f = fixture();
  f.handle.mockRejectedValueOnce(new Error("connection lost"));
  expect(await f.port.run(request, new AbortController().signal)).toMatchObject({ status: "unknown", usage: null });
  f.sessions.getRequestReplayById.mockRejectedValueOnce(new Error("unavailable"));
  expect(await f.port.inspect(request)).toMatchObject({ status: "unknown" });
  expect(f.handle).toHaveBeenCalledOnce();
});

test("session creation refuses adoption, and a missing continued session is never recreated", async () => {
  const f = fixture();
  await expect(f.port.createSession(request)).rejects.toThrow("agents_work_session_already_exists");
  expect(f.sessions.getOrCreateSession).not.toHaveBeenCalled();
  f.sessions.getSessionById.mockResolvedValue(null);
  await f.port.createSession(request);
  expect(f.sessions.getOrCreateSession).toHaveBeenCalledExactlyOnceWith(request.sessionId);
  await expect(f.port.run(request, new AbortController().signal)).rejects.toThrow("agents_work_session_missing");
  expect(f.handle).not.toHaveBeenCalled();
  expect(f.sessions.getOrCreateSession).toHaveBeenCalledOnce();
});

test("pre-dispatch abort does not call the ordinary handler", async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort(new Error("stop"));
  await expect(f.port.run(request, abort.signal)).rejects.toThrow("stop");
  expect(f.handle).not.toHaveBeenCalled();
});

test("approval decisions and subscriptions delegate to the existing owner with exact target", async () => {
  const f = fixture();
  const decision = { approvalId: "approval-a", approved: true, commandId: "command-a", generation: "generation-a", waitId: "wait-a", revision: 2 };
  expect(await f.port.decideApproval(request, decision)).toEqual({ accepted: true });
  expect(f.decide).toHaveBeenCalledExactlyOnceWith({ ...decision, sessionId: request.sessionId, requestId: request.requestId });
  const listener = vi.fn(); f.port.subscribeEvents(listener);
  expect(f.subscribeEvents).toHaveBeenCalledExactlyOnceWith(listener);
  expect(f.handle).not.toHaveBeenCalled();
});

test("cancellation delegates a saved wait's exact existing identity", async () => {
  const f = fixture();
  f.replay.value = { ...terminal(), finalState: null, events: [], lifecycle: { schemaVersion: 1,
    sessionId: request.sessionId, requestId: request.requestId, generation: "generation-a", status: "awaiting_approval",
    revision: 3, activation: { activationId: "activation-a", ownerEpoch: "owner-a" }, decisionReceipts: [],
    wait: { waitId: "wait-a", createdAt: "2026-11-17T10:00:00.000Z", presentationMessageId: "msg-1", approvals: [] } } };
  await f.port.cancel!(request);
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(request.requestId, request.sessionId,
    { generation: "generation-a", waitId: "wait-a", revision: 3, commandId: expect.any(String) });
  expect(f.handle).not.toHaveBeenCalled();
});

test("presentation events cannot redirect the request or fail its execution", async () => {
  const f = fixture(); f.onEvent.mockImplementation(() => { throw new Error("view failed"); });
  f.handle.mockImplementationOnce(async (socket) => {
    socket.send(JSON.stringify({ requestId: "foreign", type: "completed" }));
    socket.send(JSON.stringify({ requestId: request.requestId, type: "event", name: "status" }));
    f.replay.value = terminal();
  });
  expect(await f.port.run(request, new AbortController().signal)).toMatchObject({ status: "completed" });
  expect(f.onEvent).toHaveBeenCalledOnce();
});


test("live usage observes only the exact existing request generation and never invokes work", async () => {
  const f = fixture();
  const binding = {requestId:request.requestId,sessionId:request.sessionId,generation:"generation-a"};
  f.replay.value = {...terminal(),finalState:null,events:[
    {...binding,name:"context.window.snapshot",invocationId:"a",admissionOutcome:"accepted"},
    {...binding,name:"context.window.provider_usage",invocationId:"a",measurement:"actual",source:"provider_reported",totalTokens:123},
    {...binding,name:"context.window.snapshot",invocationId:"b",admissionOutcome:"accepted"},
  ]};
  expect(await f.port.inspectUsage!(request)).toEqual({modelCalls:2,totalTokens:123});
  f.replay.value.events[1]!.generation = "different-generation";
  expect(await f.port.inspectUsage!(request)).toBeNull();
  f.replay.value.sessionId = "another-session";
  expect(await f.port.inspectUsage!(request)).toBeNull();
  expect(f.handle).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
});
