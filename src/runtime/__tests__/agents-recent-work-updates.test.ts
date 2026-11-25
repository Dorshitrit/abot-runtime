import { expect, test, vi } from "vitest";
import { createEmptyAgentState, type AgentState } from "../agents/agent-records.js";
import { projectAgentDetail } from "../agents/application-view.js";
import { createAgentChatUpdates } from "../agents/chat-updates.js";
import { remoteAgentSummary } from "../agents/remote-workspace-view.js";
import type { RemoteAgentCommand } from "../agents/remote-workspace-input.js";
import type { AgentWorkAttempt } from "../agents/workspace-records.js";
import type { SessionStore } from "../ports.js";
import { SessionService } from "../../sessions/session-service.js";
import type { SessionRecord, SessionRequestRecord, SessionRuntimeEvent } from "../../sessions/types.js";
import { agentDefinition, agentMissionLimits } from "./support/agents-foundation-fixture.js";

const at = "2032-04-17T12:30:00.000Z";
const iso = (index: number) => new Date(Date.parse(at) + index * 1000).toISOString();
const local: RemoteAgentCommand = { type: "agents.list.request", local: true, allowedModes: ["ask", "full_access", "full_plus"] };

function localUpdates(summary: Awaited<ReturnType<typeof remoteAgentSummary>>) {
  if (!("recentWorkUpdates" in summary)) throw new Error("Expected the local catalogue projection.");
  return summary.recentWorkUpdates;
}

function acknowledgement(request: SessionRequestRecord, index: number, text = `Public update ${index}`): SessionRuntimeEvent {
  return { requestId: request.requestId, seqNo: index + 1, type: "event", timestamp: iso(index),
    payload: { name: "thinking.delta", presentationKind: "acknowledgement", requestId: request.requestId,
      sessionId: request.sessionId, generation: request.generation, text } };
}

function fixture(count = 1) {
  const agent = { id: "a", revision: 1, status: "active" as const, definition: agentDefinition(), createdAt: at, updatedAt: at };
  const mission = { id: "m", agentId: "a", revision: 1, status: "completed" as const, objective: "PRIVATE task", successCriteria: [],
    waitingReason: null, limits: agentMissionLimits(), usage: { attempts: count, modelCalls: 0, totalTokens: 0, consecutiveNoProgress: 0, clarificationRounds: 0 }, createdAt: at, updatedAt: at };
  let state: AgentState = { ...createEmptyAgentState(), agents: [agent], missions: [mission],
    messages: [{ id: "origin", agentId: "a", missionId: "m", role: "user", purpose: "request", source: null, text: "PRIVATE task", createdAt: at }] };
  const records = new Map<string, SessionRecord>();
  for (let index = 0; index < count; index++) {
    const sessionId = `s${index}`, requestId = `r${index}`, attemptId = `t${index}`;
    const request: SessionRequestRecord = { sessionId, requestId, generation: "g", status: "completed", createdAt: at,
      updatedAt: iso(index), lastSeqNo: index + 1, events: [] };
    request.events = [acknowledgement(request, index)];
    records.set(sessionId, { id: sessionId, title: "PRIVATE session", createdAt: at, updatedAt: iso(index),
      lastAgentMode: "reasoning", messageCount: 0, messages: [], requests: [request] });
    const attempt: AgentWorkAttempt = { id: attemptId, agentId: "a", missionId: "m", agentRevision: 1, missionRevision: 1,
      request: { agentId: "a", missionId: "m", attemptId, sessionId, requestId, assignment: "PRIVATE assignment", modelProfileId: "p", toolPermissionMode: "ask" },
      mode: "new", fingerprint: "fixture", status: "settled", claimId: `claim${index}`, outputHash: null, userResolved: false,
      result: { status: "completed", receiptId: `${requestId}:g:${index + 1}`, output: "PRIVATE result", error: null, usage: null }, createdAt: at, updatedAt: iso(index) };
    state = { ...state, attempts: [...state.attempts, attempt],
      sessions: [...state.sessions, { sessionId, agentId: "a", purpose: "PRIVATE work", createdAt: at }] };
  }
  const sessions = new SessionService() satisfies SessionStore;
  const getSessionById = vi.spyOn(sessions, "getSessionById").mockImplementation(async id => records.get(id) ?? null);
  const detail = () => projectAgentDetail(state, "a", false);
  const recent = async () => localUpdates(await remoteAgentSummary(detail(), local, sessions, state));
  return { get state() { return state; }, replace: (patch: Partial<AgentState>) => { state = { ...state, ...patch }; },
    records, sessions, getSessionById, detail, recent };
}

test("repeated catalogue polls retain ten public updates without rereading more than 128 old receipts", async () => {
  const f = fixture(130);
  const updates = await f.recent();
  expect(updates).toHaveLength(10);
  expect(updates?.map(update => update.text)).toEqual(Array.from({ length: 10 }, (_, index) => `Public update ${129 - index}`));
  expect(f.getSessionById).toHaveBeenCalledTimes(130);
  for (let poll = 0; poll < 3; poll++) {
    f.replace({ revision: f.state.revision + 1 });
    expect(await f.recent()).toEqual(updates);
  }
  expect(f.getSessionById).toHaveBeenCalledTimes(130);
  expect(JSON.stringify(updates)).not.toContain("PRIVATE");
});

test.each(["failed", "cancelled"] as const)("a %s attempt without a receipt does not disable confirmed history caching", async status => {
  const f = fixture(131);
  const attempt = f.state.attempts[130]!;
  f.replace({ attempts: [...f.state.attempts.slice(0, 130), { ...attempt,
    result: { status, receiptId: null, output: null, error: "Stopped before request admission", usage: { modelCalls: 0, totalTokens: 0 } } }] });
  if (status === "failed") f.records.delete("s130");
  else f.records.get("s130")!.requests = [];
  const updates = await f.recent();
  expect(updates?.map(update => update.text)).toEqual(Array.from({ length: 10 }, (_, index) => `Public update ${129 - index}`));
  expect(f.getSessionById).toHaveBeenCalledTimes(131);
  f.getSessionById.mockClear();
  for (let poll = 0; poll < 3; poll++) expect(await f.recent()).toEqual(updates);
  expect(f.getSessionById.mock.calls).toEqual([["s130"], ["s130"], ["s130"]]);
});

test("pending session events refresh without Agent revision changes and a new final receipt enters history", async () => {
  const f = fixture(2);
  const request = f.records.get("s1")!.requests![0]!;
  const terminal = f.state.attempts[1]!;
  f.replace({ attempts: [f.state.attempts[0]!, { ...terminal, status: "running", result: null }] });
  request.status = "streaming";
  await f.recent();
  f.getSessionById.mockClear();
  const revision = f.state.revision;
  request.events = [acknowledgement(request, 10, "Still working")];
  expect(await f.recent()).toContainEqual(expect.objectContaining({ text: "Still working" }));
  expect(f.state.revision).toBe(revision);
  expect(f.getSessionById).toHaveBeenCalledExactlyOnceWith("s1");
  request.status = "completed";
  request.events = [acknowledgement(request, 11, "Work finished")];
  f.replace({ attempts: [f.state.attempts[0]!, { ...terminal, result: { ...terminal.result!, receiptId: "r1:g:12" } }] });
  const settled = await f.recent();
  expect(settled).toContainEqual(expect.objectContaining({ text: "Work finished" }));
  f.getSessionById.mockClear();
  expect(await f.recent()).toEqual(settled);
  expect(f.getSessionById).not.toHaveBeenCalled();
});

test("changed exact source bindings invalidate history and missing session evidence is retried", async () => {
  const f = fixture();
  f.getSessionById.mockResolvedValueOnce(null);
  expect(await f.recent()).toEqual([]);
  expect(await f.recent()).toHaveLength(1);
  f.replace({ sessions: [] });
  expect(await f.recent()).toEqual([]);
  f.replace({ sessions: [{ sessionId: "s0", agentId: "a", purpose: "Work", createdAt: at }],
    attempts: [{ ...f.state.attempts[0]!, createdAt: iso(1) }] });
  expect(await f.recent()).toEqual([]);
  f.replace({ attempts: [{ ...f.state.attempts[0]!, createdAt: at }] });
  expect(await f.recent()).toHaveLength(1);
  f.replace({ messages: [] });
  expect(await f.recent()).toEqual([]);
});

test("the catalogue shows each child original once while parent chat still forwards it", async () => {
  const f = fixture();
  const parent = { ...f.state.agents[0]!, id: "abot" };
  const mission = { ...f.state.missions[0]!, id: "parent", agentId: "abot" };
  const parentMessage = { ...f.state.messages[0]!, id: "parent-origin", agentId: "abot", missionId: "parent" };
  f.replace({ agents: [...f.state.agents, parent], missions: [...f.state.missions, mission],
    messages: [{ ...f.state.messages[0]!, role: "abot", source: { agentId: "abot", missionId: "parent", correlationId: "exchange" } }, parentMessage],
    mailbox: [{ id: "exchange", traceId: "trace", agentId: "abot", missionId: "parent", missionRevision: 1,
    recipientAgentId: "a", assignment: "PRIVATE assignment", limits: agentMissionLimits(), status: "answered", outcome: "completed",
    output: "PRIVATE reply", usage: null, createdAt: at, updatedAt: at }] });
  const parentDetail = projectAgentDetail(f.state, "abot", false);
  const child = await f.recent();
  const parentSummary = await remoteAgentSummary(parentDetail, local, f.sessions, f.state);
  expect(child).toHaveLength(1);
  expect(child?.[0]).not.toHaveProperty("sourceAgentId");
  expect(localUpdates(parentSummary)).toEqual([]);
  const forwarded = await createAgentChatUpdates(f.sessions)(parentDetail, f.state);
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]).toMatchObject({ sourceAgentId: "a", text: child![0]!.text });
  f.replace({ mailbox: [] });
  expect(await f.recent()).toEqual([]);
});
