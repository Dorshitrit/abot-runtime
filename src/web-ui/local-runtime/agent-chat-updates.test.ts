import { expect, test, vi } from "vitest";
import type { SessionRecord, SessionRequestRecord, SessionRuntimeEvent } from "../../sessions/types.js";
import type { AgentApplicationDetail } from "../../runtime/agents/application-contracts.js";
import { createEmptyAgentState, type AgentState } from "../../runtime/agents/agent-records.js";
import type { AgentInvocationRecord } from "../../runtime/agents/invocation-records.js";
import type { AgentResponsibilityTrace, AgentWorkAttempt } from "../../runtime/agents/workspace-records.js";
import { agentDefinition, agentMissionLimits } from "../../runtime/__tests__/support/agents-foundation-fixture.js";
import { createAgentChatUpdates } from "./agent-chat-updates.js";
import { progressContext } from "../../runtime/agents/progress-report.js";
import { boundAgentDelegation, directAgentRequestOrigin } from "../../runtime/agents/delegated-work-origin.js";

const at = "2032-04-17T12:30:00.000Z";
const start = Date.parse(at);
const iso = (ms: number) => new Date(start + ms).toISOString();
function fixture() {
  const req = { agentId: "a", missionId: "m", attemptId: "t", sessionId: "s", requestId: "r", assignment: "Private assignment", modelProfileId: "p", toolPermissionMode: "ask" as const };
  const attempt: AgentWorkAttempt = { id: "t", agentId: "a", missionId: "m", agentRevision: 1, missionRevision: 1, request: req, mode: "new", fingerprint: "f", status: "claimed", claimId: "claim", result: null, outputHash: null, userResolved: false, createdAt: at, updatedAt: at };
  const mission = { id: "m", agentId: "a", revision: 1, status: "active" as const, objective: "Task", successCriteria: [], waitingReason: null, limits: agentMissionLimits(),
    usage: { attempts: 1, modelCalls: 0, totalTokens: 0, consecutiveNoProgress: 0, clarificationRounds: 0 }, createdAt: at, updatedAt: at };
  const message = { id: "user", agentId: "a", missionId: "m", role: "user" as const, purpose: "request" as const, source: null, text: "Task", createdAt: at };
  const detail: AgentApplicationDetail = { agent: { id: "a", status: "active", revision: 1, definition: agentDefinition(), createdAt: at, updatedAt: at }, status: "working", mission,
    messages: [message], sessions: [{ agentId: "a", sessionId: "s", purpose: "Work", createdAt: at }], attempts: [attempt], responsibility: [], decisions: [], mailbox: [], activity: null, recovery: { requiresNewBudget: false } };
  const state: AgentState = { ...createEmptyAgentState(), agents: [detail.agent], sessions: detail.sessions, missions: [mission], messages: [message], attempts: [attempt] };
  const request: SessionRequestRecord = { sessionId: "s", requestId: "r", generation: "g", status: "streaming", createdAt: at, updatedAt: at, lastSeqNo: 2, events: usageReceipts() };
  const session: SessionRecord = { id: "s", title: "Private", createdAt: at, updatedAt: at, lastAgentMode: "reasoning", messageCount: 0, messages: [], requests: [request] };
  const getSessionById = vi.fn(async () => session as SessionRecord | null);
  const project = createAgentChatUpdates({ getSessionById });
  return { detail, state, request, attempt, session, getSessionById, project };
}
function interaction(): SessionRuntimeEvent {
  return { requestId: "r", seqNo: 3, type: "event", timestamp: iso(30), payload: { type: "event", requestId: "r", sessionId: "s", generation: "g", name: "user.interaction",
    interaction: { version: 1, kind: "message", requestId: "r", interactionId: "r:interaction:1", sequence: 1, createdAt: iso(30), origin: { callId: "call", activationCount: 1, steeringVersion: 0 }, payload: { text: "I checked the first source." } } } };
}
function usageReceipts(): SessionRuntimeEvent[] {
  const payload = { requestId: "r", sessionId: "s", generation: "g", invocationId: "call" };
  return [
    { requestId: "r", seqNo: 1, type: "event", timestamp: iso(1), payload: { ...payload, name: "context.window.snapshot", admissionOutcome: "accepted" } },
    { requestId: "r", seqNo: 2, type: "event", timestamp: iso(2), payload: { ...payload, name: "context.window.provider_usage", measurement: "actual", source: "provider_reported", totalTokens: 17 } },
  ];
}
function admission(publicUpdate = "אבדוק את המחירים ואחזור עם הממצאים."): AgentResponsibilityTrace {
  return { id: "trace", agentId: "a", missionId: "m", agentRevision: 1, missionRevision: 1, invocationId: "selection", accepted: true, code: "accepted", createdAt: at,
    plan: { action: "start_session", reason: "PRIVATE REASON", sessionId: null, recipientAgentId: null, evidenceIds: [], metCriteriaIds: [], publicUpdate } };
}
function progressReport(): AgentInvocationRecord {
  return { id: "progress", agentId: "a", missionId: "m", agentRevision: 1, missionRevision: 1, stage: "progress_report",
    status: "settled", publicUpdate: "אני עדיין בודק ואעדכן כשיהיו ממצאים.", reservedTokens: 200, usage: { totalTokens: 100, cost: { kind: "unknown" } },
    createdAt: iso(300_000), updatedAt: iso(300_100), configuration: { schemaVersion: 1, fingerprint: "configuration", modelProfileId: "p", baseProfileId: "p", toolPermissionMode: "ask",
      policy: { id: "supervisor-worker-v1", source: "model_profile", version: 1, definitionHash: "policy" } } };
}

test("confirmed work becomes due at five quiet minutes without fabricated chat text or polling side effects", async () => {
  const f = fixture(); const before = structuredClone(f.state);
  expect(await f.project.checkpoint(f.detail, f.state, start + 299_999)).toBeNull();
  const expected = await f.project.checkpoint(f.detail, f.state, start + 300_000);
  expect(expected).toEqual({ agentId: "a", missionId: "m", workId: "t", workKind: "work_session", workUsage: { modelCalls: 1, totalTokens: 17 }, dueAt: iso(300_000) });
  expect(await createAgentChatUpdates({ getSessionById: f.getSessionById }).checkpoint(f.detail, f.state, start + 900_000)).toEqual(expected);
  const recentSideMessage = { ...f.detail.messages[0]!, id: "side", purpose: "conversation" as const, createdAt: iso(899_999) };
  expect(await f.project.checkpoint({ ...f.detail, messages: [...f.detail.messages, recentSideMessage] }, f.state, start + 900_000)).toEqual(expected);
  expect(await f.project(f.detail, f.state)).toEqual([]);
  expect(f.state).toEqual(before);
});

test("only validated published interaction text from the owned request and generation is shown", async () => {
  const f = fixture(); const good = interaction();
  f.request.events = [good, good, { ...good, requestId: "other" }, { ...good, payload: { ...good.payload, generation: "other" } },
    { ...good, payload: { ...good.payload, sessionId: "other" } }, { ...good, payload: { ...good.payload, interaction: { kind: "message", payload: { text: "Private malformed text" } } } },
    { ...good, payload: { name: "tool.completed", result: "Private tool output" } }];
  const updates = await f.project(f.detail, f.state);
  expect(updates.map((u) => u.text)).toEqual(["I checked the first source."]);
  expect(updates[0]!.createdAt).toBe(iso(30));
});

test("SUPER's complete marked acknowledgement reaches chat once while unmarked thinking stays private", async () => {
  const f = fixture();
  const good: SessionRuntimeEvent = { requestId: "r", seqNo: 4, type: "event", timestamp: iso(40),
    payload: { requestId: "r", sessionId: "s", generation: "g", name: "thinking.delta", presentationKind: "acknowledgement", text: "אבדוק את המקורות ואחזור אליך.\n\n" } };
  f.request.events = [good, good, { ...good, seqNo: 5 },
    { ...good, payload: { ...good.payload, presentationKind: undefined, text: "PRIVATE THINKING" } },
    { ...good, payload: { ...good.payload, generation: "foreign" } },
    { ...good, payload: { ...good.payload, sessionId: "foreign" } },
    { ...good, payload: { ...good.payload, requestId: "foreign" } },
    { ...good, payload: { ...good.payload, generation: undefined } },
    { ...good, timestamp: "bad" }, { ...good, seqNo: 0 }];
  expect(await f.project(f.detail, f.state)).toEqual([expect.objectContaining({ createdAt: iso(40), text: good.payload.text?.toString().trim() })]);
  expect(await f.project.latest(f.detail, f.state)).toMatchObject({ createdAt: iso(40) });
  f.request.events = [{ ...good, payload: { ...good.payload, text: "x".repeat(221) } }];
  expect(await f.project(f.detail, f.state)).toEqual([]);
});

test("the first accepted work decision publishes its explicit report before authoring without exposing reasons", async () => {
  const f = fixture(); const trace = admission();
  const detail = { ...f.detail, status: "thinking" as const, attempts: [], sessions: [], responsibility: [
    { ...trace, id: "rejected", accepted: false }, { ...trace, id: "private", agentId: "another" },
    trace, { ...trace, id: "retry", createdAt: iso(10), plan: { ...trace.plan, publicUpdate: "Do not repeat an admission." } }] };
  const expected = await f.project(detail, f.state);
  expect(expected).toEqual([expect.objectContaining({ text: trace.plan.publicUpdate, createdAt: at })]);
  expect(await f.project.latest(detail, f.state)).toEqual(expected[0]);
  expect(await createAgentChatUpdates({ getSessionById: f.getSessionById })(detail, f.state)).toEqual(expected);
  expect(f.getSessionById).not.toHaveBeenCalled();
  expect(JSON.stringify(expected)).not.toContain("PRIVATE");
  expect(await f.project({ ...detail, responsibility: [{ ...trace, plan: { ...trace.plan, publicUpdate: undefined } }, ...detail.responsibility] }, f.state)).toEqual([]);
});

test("settled model progress survives completion and reopening, excluding pending and private calls", async () => {
  const f = fixture(); const report = progressReport();
  const state = { ...f.state, invocations: [report, { ...report, id: "reserved", status: "reserved" as const },
    { ...report, id: "unmeasured", status: "usage_unknown" as const },
    { ...report, id: "author", stage: "authoring" as const }, { ...report, id: "private", agentId: "other" },
    { ...report, id: "history", missionId: "private-mission" }] };
  const detail = { ...f.detail, attempts: [], mission: { ...f.detail.mission!, status: "completed" as const } };
  const updates = await f.project(detail, state);
  expect(updates).toEqual([expect.objectContaining({ text: report.publicUpdate, createdAt: report.updatedAt })]);
  expect(await createAgentChatUpdates({ getSessionById: f.getSessionById })(detail, state)).toEqual(updates);
  expect(await f.project.latest(detail, state)).toBeNull();
});

test("no confirmation, foreign ownership or delegated private mission cannot produce progress", async () => {
  const f = fixture(); f.request.events.push(interaction());
  f.getSessionById.mockResolvedValueOnce(null);
  expect(await f.project(f.detail, f.state)).toEqual([]);
  f.getSessionById.mockResolvedValueOnce({ ...f.session, id: "other" });
  expect(await f.project(f.detail, f.state)).toEqual([]);
  f.request.generation = "other";
  expect(await f.project({ ...f.detail, attempts: [{ ...f.attempt, result: { status: "running", receiptId: "r:g:2", error: null, output: null, usage: null } }] }, f.state)).toEqual([]);
  f.getSessionById.mockClear();
  expect(await f.project({ ...f.detail, sessions: [] }, f.state)).toEqual([]);
  const privateDetail = { ...f.detail, responsibility: [admission()], messages: [{ ...f.detail.messages[0]!, role: "abot" as const, source: { agentId: "abot", missionId: "parent", correlationId: "exchange" } }] };
  expect(await f.project(privateDetail, { ...f.state, invocations: [progressReport()] })).toEqual([]);
  expect(f.getSessionById).not.toHaveBeenCalled();
});

test("waiting, unknown, finished and archived work cannot trigger a model checkpoint", async () => {
  const f = fixture(); const now = start + 600_000;
  for (const status of ["awaiting_approval", "failed", "completed"] as const) {
    f.request.status = status;
    expect(await f.project.checkpoint(f.detail, f.state, now)).toBeNull();
  }
  f.request.status = "streaming";
  for (const status of ["awaiting_approval", "awaiting_user_decision", "failed", "archived"] as const)
    expect(await f.project.checkpoint({ ...f.detail, status }, f.state, now)).toBeNull();
  expect(await f.project.checkpoint({ ...f.detail, attempts: [{ ...f.attempt, status: "unknown" }] }, f.state, now)).toBeNull();
  expect(await f.project.checkpoint({ ...f.detail, agent: { ...f.detail.agent, status: "archived" } }, f.state, now)).toBeNull();
});

test("approval resume excludes the idle interval from quiet execution time", async () => {
  const f = fixture();
  const activation = { activationId: "a1", ownerEpoch: "owner" };
  f.request.lifecycle = { schemaVersion: 1, revision: 2, activation, decisionReceipts: [{ requestId: "r", generation: "g", waitId: "w", approvalId: "approval", approved: true, commandId: "decision", revision: 2, committedAt: iso(600_000), activation }] };
  expect(await f.project.checkpoint(f.detail, f.state, start + 899_999)).toBeNull();
  expect(await f.project.checkpoint(f.detail, f.state, start + 900_000)).toMatchObject({ dueAt: iso(900_000) });
});

test("simultaneous reads share I/O and completed public reports remain visible during Agent evaluation", async () => {
  const f = fixture(); f.request.events.push(interaction()); f.request.status = "completed";
  const terminal: AgentWorkAttempt = { ...f.attempt, status: "settled", updatedAt: iso(500), result: { status: "completed", receiptId: "r:g:3", error: null, output: "Private whole result", usage: null } };
  const detail = { ...f.detail, status: "thinking" as const, attempts: [terminal] };
  const [first, second] = await Promise.all([f.project(detail, f.state), f.project(detail, f.state)]);
  expect(first).toEqual(second); expect(f.getSessionById).toHaveBeenCalledTimes(1);
  expect(await f.project(detail, f.state)).toEqual(first); expect(f.getSessionById).toHaveBeenCalledTimes(1);
  expect(await createAgentChatUpdates({ getSessionById: f.getSessionById })(detail, f.state)).toEqual(first);
  expect(first.map((u) => u.text)).toEqual(["I checked the first source."]);
  expect(await f.project.latest(detail, f.state)).toEqual(first[0]);
  expect(await f.project.checkpoint(detail, f.state, start + 600_000)).toBeNull();
});

test("a fresh public report restarts quiet-time measurement without losing earlier execution receipts", async () => {
  const f = fixture(); f.request.events.push(interaction());
  expect(await f.project.checkpoint(f.detail, f.state, start + 300_029)).toBeNull();
  expect(await f.project.checkpoint(f.detail, f.state, start + 300_030)).toMatchObject({ dueAt: iso(300_030), lastUpdateText: "I checked the first source." });
  const report = progressReport(); const state = { ...f.state, invocations: [report] };
  expect(await f.project.checkpoint(f.detail, state, start + 600_099)).toBeNull();
  expect(await f.project.checkpoint(f.detail, state, start + 600_100)).toMatchObject({ dueAt: iso(600_100), lastUpdateText: report.publicUpdate });
  const trace = { ...admission(), createdAt: iso(200_000) };
  expect(await f.project.checkpoint({ ...f.detail, responsibility: [trace] }, f.state, start + 499_999)).toBeNull();
  expect(await f.project.checkpoint({ ...f.detail, responsibility: [trace] }, f.state, start + 500_000)).toMatchObject({ dueAt: iso(500_000), lastUpdateText: trace.plan.publicUpdate });
});

test("multiple attempts combine confirmed work without counting gaps or overlapping intervals twice", async () => {
  const f = fixture();
  const first: AgentWorkAttempt = { ...f.attempt, id: "t0", request: { ...f.attempt.request, requestId: "r0", attemptId: "t0" }, status: "settled",
    result: { status: "completed", output: "Result", error: null, usage: null, receiptId: "r0:g0:2" }, updatedAt: iso(180_000) };
  const priorRequest = { ...f.request, requestId: "r0", generation: "g0", status: "completed" as const, updatedAt: iso(180_000), events: [] };
  f.request.createdAt = iso(200_000); f.request.updatedAt = f.request.createdAt;
  f.session.requests = [priorRequest, f.request];
  const detail = { ...f.detail, attempts: [first, { ...f.attempt, createdAt: f.request.createdAt }] };
  expect(await f.project.checkpoint(detail, f.state, start + 319_999)).toBeNull();
  expect(await f.project.checkpoint(detail, f.state, start + 320_000)).toMatchObject({ dueAt: iso(320_000) });
  const overlap = { ...detail, attempts: [first, first, detail.attempts[1]!] };
  expect(await f.project.checkpoint(overlap, f.state, start + 319_999)).toBeNull();
});

test("model checkpoint rejects ambiguous measurements and preserves freshness at the spending limit", async () => {
  const f = fixture(); const receipts = usageReceipts();
  for (const events of [
    [],
    [receipts[0]!, { ...receipts[1]!, payload: { ...receipts[1]!.payload, measurement: "estimated" } }],
    [receipts[0]!, { ...receipts[1]!, payload: { ...receipts[1]!.payload, generation: "other" } }],
    [receipts[0]!, { ...receipts[1]!, payload: { ...receipts[1]!.payload, sessionId: undefined } }],
    [...receipts, { ...receipts[1]!, payload: { ...receipts[1]!.payload, totalTokens: 18 } }],
  ]) {
    f.request.events = events;
    expect(await f.project.checkpoint(f.detail, f.state, start + 600_000)).toBeNull();
  }
  f.request.events = receipts;
  for (const usage of [{ modelCalls: 23, totalTokens: 0 }, { modelCalls: 0, totalTokens: 19_983 }]) {
    const detail = { ...f.detail, mission: { ...f.detail.mission!, usage: { ...f.detail.mission!.usage, ...usage } } };
    expect(await f.project.checkpoint(detail, f.state, start + 600_000)).toEqual(await f.project.checkpoint(f.detail, f.state, start + 600_000));
  }
  expect(await f.project.checkpoint(f.detail, f.state, start + 600_000)).toMatchObject({ workUsage: { modelCalls: 1, totalTokens: 17 } });
});

test("the delegator cannot spend a second reporting allowance while its child owns the work", async () => {
  const f = fixture();
  const exchange = { id: "e", traceId: "trace", agentId: "abot", missionId: "m", missionRevision: 1, recipientAgentId: "child", assignment: "PRIVATE ASSIGNMENT",
    limits: agentMissionLimits(), status: "pending" as const, outcome: null, output: null, usage: null, createdAt: at, updatedAt: at };
  const detail = { ...f.detail, agent: { ...f.detail.agent, id: "abot" }, mission: { ...f.detail.mission!, agentId: "abot" },
    attempts: [], mailbox: [exchange], messages: [{ ...f.detail.messages[0]!, agentId: "abot" }] };
  const receipt = { ...f.detail.messages[0]!, agentId: "child", missionId: "child-mission", role: "abot" as const, text: "PRIVATE ASSIGNMENT",
    source: { agentId: "abot", missionId: "m", correlationId: exchange.id } };
  const childMission = { ...f.detail.mission!, id: "child-mission", agentId: "child" };
  const state = { ...f.state, mailbox: [exchange], messages: [...detail.messages, receipt, { ...receipt, id: "reply", purpose: "reply" as const, text: "PRIVATE REPLY" }], missions: [detail.mission, childMission] };
  expect(await f.project.checkpoint(detail, f.state, start + 600_000)).toBeNull();
  expect(await f.project.checkpoint(detail, state, start + 600_000)).toBeNull();
  expect(await f.project(detail, state)).toEqual([]);
  expect(f.getSessionById).not.toHaveBeenCalled();
  expect(await f.project.checkpoint(detail, { ...state, missions: [detail.mission, { ...childMission, status: "awaiting_user_decision" }] }, start + 600_000)).toBeNull();
});

test("a slow admitted model call remains eligible for a five-minute report with its observed usage lower bound", async () => {
  const f = fixture();
  f.request.events = usageReceipts().slice(0, 1);
  expect(await f.project.checkpoint(f.detail, f.state, start + 300_000)).toMatchObject({ workUsage: { modelCalls: 1, totalTokens: 0 }, dueAt: iso(300_000) });
  f.request.events = [...usageReceipts(), { ...usageReceipts()[0]!, seqNo: 3, payload: { ...usageReceipts()[0]!.payload, invocationId: "open-call" } }];
  const before = structuredClone(f.state);
  expect(await f.project.checkpoint(f.detail, f.state, start + 300_000)).toMatchObject({ workUsage: { modelCalls: 2, totalTokens: 17 } });
  expect(f.state).toEqual(before);
});


function delegatedFixture() {
  const f = fixture();
  const parentAgent = { ...f.detail.agent, id: "abot", definition: { ...f.detail.agent.definition, name: "Coordinator" } };
  const parentMission = { ...f.detail.mission!, id: "parent", agentId: "abot" };
  const parentMessage = { ...f.detail.messages[0]!, id: "parent-request", agentId: "abot", missionId: "parent", text: "בדוק את המקורות" };
  const source = { agentId: "abot", missionId: "parent", correlationId: "exchange" };
  const message = { ...f.detail.messages[0]!, role: "abot" as const, source, text: "PRIVATE_ASSIGNMENT" };
  const detail = { ...f.detail, messages: [message], responsibility: [admission()] };
  const exchange = { id: "exchange", traceId: "parent-trace", agentId: "abot", missionId: "parent", missionRevision: 1,
    recipientAgentId: "a", assignment: "PRIVATE_ASSIGNMENT", limits: agentMissionLimits(), status: "pending" as const,
    outcome: null, output: null, usage: null, createdAt: at, updatedAt: at };
  const state: AgentState = { ...f.state, agents: [...f.state.agents, parentAgent], missions: [...f.state.missions, parentMission],
    messages: [parentMessage, message], responsibility: detail.responsibility, mailbox: [exchange] };
  const parentDetail: AgentApplicationDetail = { ...f.detail, agent: parentAgent, mission: parentMission,
    messages: [parentMessage], attempts: [], sessions: [], mailbox: [exchange], responsibility: [] };
  return { ...f, detail, state, exchange, message, parentDetail, parentMessage };
}

test("bound delegated work produces a checkpoint using only the original human request", async () => {
  const f = delegatedFixture(); f.request.events.push(interaction());
  const before = structuredClone(f.state);
  const updates = await f.project(f.detail, f.state);
  expect(updates.map(update => update.text)).toEqual([admission().plan.publicUpdate, "I checked the first source."]);
  expect(await f.project.latest(f.detail, f.state)).toEqual(updates.at(-1));
  expect(await createAgentChatUpdates({ getSessionById: f.getSessionById })(f.detail, f.state)).toEqual(updates);
  expect(JSON.stringify(updates)).not.toContain("PRIVATE");
  const checkpoint = await f.project.checkpoint(f.detail, f.state, start + 600_000);
  expect(checkpoint).toMatchObject({ agentId: "a", missionId: "m", workId: "t", workKind: "work_session", dueAt: iso(300_030) });
  const context = progressContext(f.state, f.detail.mission!, checkpoint!);
  expect(context.map(message => message.role)).toEqual(["system", "system", "user"]);
  expect(context.at(-1)).toEqual({ role: "user", content: f.parentMessage.text });
  expect(JSON.stringify(context)).not.toContain("PRIVATE");
  expect(f.state).toEqual(before);
  for (const patch of [{ id: "other" }, { agentId: "other" }, { missionId: "other" }, { recipientAgentId: "other" }]) {
    expect(await f.project(f.detail, { ...f.state, mailbox: [{ ...f.exchange, ...patch }] })).toEqual([]);
    expect(await f.project.checkpoint(f.detail, { ...f.state, mailbox: [{ ...f.exchange, ...patch }] }, start + 600_000)).toBeNull();
  }
  expect(await f.project({ ...f.detail, sessions: [] }, f.state)).toEqual([updates[0]]);
  expect(await f.project({ ...f.detail, messages: [{ ...f.message, purpose: "clarification" as const }] }, f.state)).toEqual([]);
});

test("parent chat forwards public child reports with provenance and stable identities, including after settlement", async () => {
  const f = delegatedFixture(); f.request.events.push(interaction());
  const state = { ...f.state, messages: [...f.state.messages, { ...f.message, id: "private-reply", role: "assistant" as const,
    purpose: "reply" as const, text: "PRIVATE_REPLY" }], invocations: [progressReport()] };
  const reports = await f.project(f.parentDetail, state);
  expect(reports.map(report => report.text)).toEqual([admission().plan.publicUpdate, "I checked the first source.", progressReport().publicUpdate]);
  expect(reports.every(report => report.missionId === "parent" && report.sourceAgentId === "a" &&
    report.sourceMissionId === "m" && report.exchangeId === "exchange" && report.sourceAgentName === f.detail.agent.definition.name)).toBe(true);
  expect(new Set(reports.map(report => report.id)).size).toBe(3);
  expect(JSON.stringify(reports)).not.toContain("PRIVATE");
  expect(await f.project.latest(f.parentDetail, state)).toEqual(reports.at(-1));
  expect(await f.project.checkpoint(f.parentDetail, state, start + 600_000)).toBeNull();
  const settled: AgentState = { ...state, mailbox: [{ ...f.exchange, status: "answered", outcome: "completed", output: "PRIVATE_RESULT" }],
    missions: state.missions.map(mission => ({ ...mission, status: "completed" })) };
  expect(await createAgentChatUpdates({ getSessionById: f.getSessionById })(f.parentDetail, settled)).toEqual(reports);
  const unrelated = { ...f.parentDetail, mission: { ...f.parentDetail.mission!, id: "unrelated" },
    messages: [{ ...f.parentMessage, missionId: "unrelated" }] };
  expect(await f.project(unrelated, state)).toEqual([]);
});

test("cancelled ancestors, ambiguous receipts and cyclic delegation cannot admit a progress call", async () => {
  const f = delegatedFixture();
  for (const status of ["cancelled", "completed", "awaiting_user_decision"] as const) {
    const state = { ...f.state, missions: f.state.missions.map(mission => mission.id === "parent" ? { ...mission, status } : mission) };
    expect(await f.project.checkpoint(f.detail, state, start + 600_000)).toBeNull();
  }
  const ambiguous = { ...f.state, messages: [...f.state.messages, { ...f.message, id: "another-receipt" }] };
  expect(boundAgentDelegation(ambiguous, f.exchange)).toBeNull();
  expect(directAgentRequestOrigin(ambiguous, "a", "m")).toBeNull();
  expect(await f.project.checkpoint(f.detail, ambiguous, start + 600_000)).toBeNull();
  const cycle = { ...f.state, messages: [f.message, { ...f.parentMessage, role: "abot" as const,
    source: { agentId: "a", missionId: "m", correlationId: "back" } }], mailbox: [f.exchange,
    { ...f.exchange, id: "back", agentId: "a", missionId: "m", recipientAgentId: "abot" }] };
  expect(directAgentRequestOrigin(cycle, "a", "m")).toBeNull();
  expect(await f.project.checkpoint(f.detail, cycle, start + 600_000)).toBeNull();
  expect(await f.project(f.parentDetail, cycle)).toHaveLength(1);
});
