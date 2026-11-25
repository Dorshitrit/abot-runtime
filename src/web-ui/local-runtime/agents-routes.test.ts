import { agentReplyId, type AgentNotificationInbox } from "./agent-chat-notifications.js";
import type { AgentReplyNotification } from "../notifications/contracts.js";
import { createAgentScheduleService } from "../../runtime/agents/schedule-service.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../../sessions/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { FileAgentStateStore } from "../../runtime/agents/file-store.js";
import { createAgentManagementService } from "../../runtime/agents/management-service.js";
import { projectAgentDetail } from "../../runtime/agents/application-view.js";
import type { AgentApplicationDetail } from "../../runtime/agents/application-contracts.js";
import type { RuntimeConfig } from "../../runtime/ports.js";
import { createAgentDeletion } from "../../runtime/agents/deletion.js";
import { createAgentWorkspaceApprovals } from "../../runtime/agents/workspace-approvals.js";
import { attentionMessageIdsThrough } from "../../runtime/agents/attention.js";
import { executeRemoteAgentCommand } from "../../runtime/agents/remote-workspace.js";
import type { AgentWorkspaceOperations } from "../../runtime/agents/workspace-client-contracts.js";
import type { RuntimeEnvironment, JsonObject } from "./contracts.js";
import { WebAgentRoutes } from "./agents-routes.js";
import type { WebAgentEnvironment } from "./agents-registry.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const limits = { maxAttempts: 3, maxModelCalls: 12, maxTotalTokens: 20000, maxConsecutiveNoProgress: 2, maxClarificationRounds: 2 };
const definition = { name: "Scout", icon: "pebbles-blue", basePrompt: "Research accepted requests.", modelProfileId: "fixture", toolPermissionMode: "ask" };
async function fixture(inbox?: AgentNotificationInbox) {
  const directory = await mkdtemp(join(tmpdir(), "abot-agent-routes-")); directories.push(directory);
  const config = { models: { profiles: { fixture: { model: "fictional" } }, defaults: { profileId: "fixture" } }, paths: { runtimeDir: directory } } as unknown as RuntimeConfig;
  const store = new FileAgentStateStore(join(directory, "agents", "state.json"));
  const management = createAgentManagementService(store, config);
  const getSessionSnapshot = vi.fn(async (sessionId: string) => ({ sessionId, messages: [] }));
  const getSessionById = vi.fn(async (_id: string): Promise<SessionRecord | null> => null);
  const environment = { services: { config, sessions: { getSessionSnapshot, getSessionById } } } as unknown as RuntimeEnvironment;
  const detail = async (id: string): Promise<AgentApplicationDetail> => projectAgentDetail(await store.read(), id, false);
  const application = { detail, refresh: vi.fn(detail), snapshot: async () => ({ revision: (await store.read()).revision, agents: await Promise.all((await store.read()).agents.map((agent) => detail(agent.id))) }),
    send: vi.fn(async (id: string) => detail(id)), cancel: vi.fn(detail), pause: vi.fn(detail), steer: vi.fn(async (id: string) => detail(id)), resolve: vi.fn(async (id: string) => detail(id)) };
  const work = { listApprovals: vi.fn(async () => []), decideApproval: vi.fn(async () => ({ accepted: true as const })) };
  const schedules = createAgentScheduleService({ filename: join(directory, "agents", "schedules.json"), application });
  const sessions = environment.services.sessions;
  const cleanup = createAgentDeletion({ directory: join(directory, "agents"), store, sessions, attachments: undefined,
    removeSchedules: id => schedules.removeForAgent(id), forgetSession: async () => {}, forgetAgent: async () => {}, onRecoveryError() {} });
  const deletion = { remove: vi.fn(cleanup.remove) };
  const approvals = createAgentWorkspaceApprovals(application, work, sessions);
  const projection = { through: async (id: string, through: string) => attentionMessageIdsThrough(await application.detail(id), through) };
  const workspace = { store, management, application, schedules, deletion, approvals, work, projection } as unknown as AgentWorkspaceOperations;
  const entry = { local: (command: Record<string, unknown>) => executeRemoteAgentCommand(workspace, sessions, command, true),
    projection, sync: vi.fn(async () => {}) } as unknown as WebAgentEnvironment;
  const routes = new WebAgentRoutes(() => environment, inbox); vi.spyOn(routes.registry, "get").mockResolvedValue(entry);
  async function call(method: string, path: string, body: JsonObject | null = null, headers: Record<string, string> = {}) {
    let status = 0; let payload: any;
    const response = { setHeader: vi.fn(), writeHead: (code: number) => { status = code; }, end: (raw: string) => { payload = JSON.parse(raw); } } as unknown as ServerResponse;
    const request = { headers: { "content-type": "application/json", host: "localhost", ...headers }, socket: {} } as IncomingMessage;
    const handled = await routes.handle({ method, segments: path.split("/"), body, environmentId: "dev", request, response });
    return { handled, status, payload };
  }
  async function create(name = "Scout") { return call("POST", "agents", { definition: { ...definition, name }, limits, expectedRevision: (await store.read()).revision }); }
  const remote = (command: Record<string, unknown>) => executeRemoteAgentCommand(workspace, sessions, { allowedModes: ["ask"], ...command });
  return { remote, call, create, store, management, application, work, deletion, getSessionSnapshot, getSessionById };
}

test("Agent creation persists the selected model, policy and explicit budget; catalogue status stays separate", async () => {
  const f = await fixture(); const created = await f.create();
  expect(created.status).toBe(201); expect(created.payload.agent.definition).toMatchObject({ ...definition, defaultLimits: limits, executionPolicy: "supervisor-worker-v1" });
  expect(created.payload.limits).toEqual(limits);
  const catalog = await f.call("GET", "agents");
  expect(catalog.payload.agents[0]).toMatchObject({ status: "active", workStatus: "idle", limits });
  expect(f.application.send).not.toHaveBeenCalled();
});

test("catalogue previews only this Agent's last message to the user", async () => {
  const f = await fixture();
  const id = (await f.create()).payload.agent.id;
  const detail = await f.application.detail(id);
  type Message = AgentApplicationDetail["messages"][number];
  const messages: Message[] = [];
  vi.spyOn(f.application, "snapshot").mockImplementation(async () => ({
    revision: 1, agents: [{ ...detail, messages }],
  }));
  const append = (key: string, role: Message["role"], text: string, extra: Partial<Message> = {}) =>
    messages.push({ id: key, role, agentId: id, missionId: "direct", createdAt: "2040-01-01T00:00:00Z",
      text, source: null, ...extra });
  const preview = async () => {
    const result = await f.call("GET", "agents");
    expect(result.status).toBe(200);
    expect(result.payload.agents[0]).not.toHaveProperty("messages");
    return result.payload.agents[0].latestAgentMessage;
  };

  append("user1", "user", "How are you?", { purpose: "conversation" });
  expect(await preview()).toBeNull();
  append("answer1", "assistant", "היי, איך אפשר לעזור?", { purpose: "reply" });
  append("user2", "user", "A newer user message", { purpose: "conversation" });
  append("other", "assistant", "Other Agent's message", { agentId: "other" });
  const source = { agentId: "abot", missionId: "parent", correlationId: "exchange" };
  append("delegated", "abot", "Internal assignment", { missionId: "child", source, purpose: "request" });
  append("question", "assistant", "Question to ABot", { missionId: "child", purpose: "question" });
  append("response", "abot", "Reply from ABot", { missionId: "child", source, purpose: "clarification" });
  append("output", "assistant", "Returned to coordinator", { missionId: "child", purpose: "reply" });
  expect(await preview()).toBe("היי, איך אפשר לעזור?");

  append("user3", "user", "How is it going?", { missionId: "child", purpose: "conversation" });
  append("reply:user3", "assistant", "Here is my update.", { missionId: "child", purpose: "reply" });
  expect(await preview()).toBe("Here is my update.");
  append("long", "assistant", "🌙".repeat(300));
  expect(await preview()).toBe("🌙".repeat(239) + "…");
  expect(f.application.send).not.toHaveBeenCalled();
  expect(f.application.refresh).not.toHaveBeenCalled();
});

test.each([
  { definition, expectedRevision: 0 },
  { definition: { ...definition, executionPolicy: "execution-agent-v1" }, limits, expectedRevision: 0 },
  { definition: { ...definition, modelProfileId: "missing" }, limits, expectedRevision: 0 },
  { definition: { ...definition, toolPermissionMode: "root" }, limits, expectedRevision: 0 },
])("rejects missing authority/budget or caller-authored policy before persistence %#", async (body) => {
  const f = await fixture(); const result = await f.call("POST", "agents", body);
  expect(result.status).toBeGreaterThanOrEqual(400); expect((await f.store.read()).agents).toEqual([]);
});

test("configuration follows mission lifetime, including terminal exhaustion", async () => {
  const f = await fixture();
  const id = (await f.create()).payload.agent.id;
  const patch = async () => f.call("PATCH", `agents/${id}`, {
    definition: { ...definition, name: "Updated Scout" }, limits: { ...limits, maxAttempts: 7 }, expectedRevision: (await f.store.read()).revision,
  });
  await f.store.commitApplication({ kind: "open_agent_turn", agentId: id, missionId: "job", messageId: "first", intent: "task", text: "Check", limits, source: null });
  expect((await patch()).payload.error).toBe("agents_agent_busy");
  await f.store.commitApplication({ kind: "mark_agent_waiting", agentId: id, missionId: "job", reason: "Ask the user" });
  expect((await patch()).payload.error).toBe("agents_agent_busy");
  await f.store.commitApplication({ kind: "finish_agent_turn", agentId: id, missionId: "job", status: "exhausted", reason: "Budget consumed" });
  const result = await patch();
  expect(result.status).toBe(200);
  expect(result.payload.agent.definition.name).toBe("Updated Scout");
  expect(result.payload.limits.maxAttempts).toBe(7);
  expect(result.payload.mission).toMatchObject({ status: "exhausted", limits });
});

test("DELETE scopes ownership server-side and reports pending cleanup for retry", async () => {
  const f = await fixture();
  const id = (await f.create()).payload.agent.id;
  const path = `agents/${id}`;
  const expectedRevision = (await f.store.read()).revision;
  expect((await f.call("DELETE", path, { expectedRevision, sessionIds: ["foreign"] })).status).toBe(400);
  expect((await f.call("DELETE", path, {})).status).toBe(400);
  expect((await f.call("DELETE", path, { expectedRevision }, { origin: "https://foreign.invalid" })).status).toBe(403);
  expect(f.deletion.remove).not.toHaveBeenCalled();
  expect((await f.call("DELETE", "agents/abot", { expectedRevision })).payload.error).toBe("agents_abot_required");
  f.deletion.remove.mockRejectedValueOnce(new Error("agents_deletion_cleanup_failed"));
  expect((await f.call("DELETE", path, { expectedRevision })).status).toBe(503);
  await f.store.beginDeletion(id, expectedRevision);
  expect((await f.call("GET", "agents")).payload.agents[0].isDeleting).toBe(true);
  expect((await f.call("GET", path)).payload.isDeleting).toBe(true);
  expect((await f.call("DELETE", path, { expectedRevision })).status).toBe(200);
  expect(f.deletion.remove).toHaveBeenLastCalledWith(id, expectedRevision);
});

test("stale edit preserves the stored Agent and returns conflict", async () => {
  const f = await fixture(); const created = await f.create(); const id = created.payload.agent.id;
  const result = await f.call("PATCH", `agents/${id}`, { definition: { ...definition, name: "Changed" }, limits, expectedRevision: 0 });
  expect(result.status).toBe(409); expect((await f.store.read()).agents[0].definition.name).toBe("Scout");
});

test("same-origin JSON is required before any Agent mutation", async () => {
  const f = await fixture(); const result = await f.call("POST", "agents", { definition, limits, expectedRevision: 0 }, { origin: "https://foreign.invalid" });
  expect(result.status).toBe(403); expect((await f.store.read()).agents).toEqual([]);
});

test.each(["auto", "task", "message"])("forwards %s and its client message ID to the Agent", async (intent) => {
  const f = await fixture();
  const created = await f.create();
  const id = created.payload.agent.id;
  const message = { text: "Compare the supplied fictional monitors.", clientMessageId: "user-1", intent };
  const result = await f.call("POST", `agents/${id}/messages`, message);
  expect(result.status).toBe(202);
  expect(f.application.send).toHaveBeenCalledExactlyOnceWith(id, { text: message.text, messageId: "user-1", intent });
});

test("rejects an unsupported message intent before admission", async () => {
  const f = await fixture();
  const created = await f.create();
  const result = await f.call("POST", `agents/${created.payload.agent.id}/messages`, {
    text: "Update", clientMessageId: "user-2", intent: "approve_tools",
  });
  expect(result.status).toBe(400);
  expect(f.application.send).not.toHaveBeenCalled();
});

test("owned session inspection cannot read a different Agent's session", async () => {
  const f = await fixture(); const a = (await f.create("First")).payload.agent.id; const b = (await f.create("Second")).payload.agent.id;
  await f.store.commit({ kind: "bind_session", agentId: a, sessionId: "private-a", purpose: "First work" }, (await f.store.read()).revision);
  expect((await f.call("GET", `agents/${b}/sessions/private-a`)).status).toBe(404);
  expect(f.getSessionSnapshot).not.toHaveBeenCalled();
  expect((await f.call("GET", `agents/${a}/sessions/private-a`)).status).toBe(200);
  expect(f.getSessionSnapshot).toHaveBeenCalledExactlyOnceWith("private-a", { includeRequests: true });
});

test("recovery forwards explicit new allowance; stop remains available without one", async () => {
  const f = await fixture(); const id = (await f.create()).payload.agent.id;
  expect((await f.call("POST", `agents/${id}/actions`, { action: "resume", text: "I checked the previous work. Start fresh.", limits })).status).toBe(200);
  expect(f.application.resolve).toHaveBeenCalledExactlyOnceWith(id, { action: "continue", text: "I checked the previous work. Start fresh.", limits });
  expect((await f.call("POST", `agents/${id}/actions`, { action: "cancel" })).status).toBe(200);
  expect(f.application.cancel).toHaveBeenCalledExactlyOnceWith(id);
});

test("archive and restore retain the Agent and never silently discard history", async () => {
  const f = await fixture(); const id = (await f.create()).payload.agent.id;
  expect((await f.call("POST", `agents/${id}/actions`, { action: "archive", expectedRevision: 1 })).payload.agent.status).toBe("archived");
  expect((await f.call("POST", `agents/${id}/actions`, { action: "restore", expectedRevision: 2 })).payload.agent.status).toBe("active");
  expect((await f.store.read()).agents).toHaveLength(1);
});

test("unexpected service failures do not expose provider details", async () => {
  const f = await fixture(); vi.spyOn(f.application, "detail").mockRejectedValueOnce(new Error("private provider response"));
  const result = await f.call("GET", "agents/missing");
  expect(result).toMatchObject({ status: 503, payload: { ok: false, error: "agents_service_unavailable" } });
});


test("onboarding choices survive the canonical definition round trip", async () => {
  const f = await fixture(); const onboarding = { role: "research", outputs: ["comparisons"], style: "concise", asks: ["unclear"], updates: "needed", custom: "", notes: "Use supplied sources.", color: "blue", budget: "short" };
  const created = await f.call("POST", "agents", { definition, limits, onboarding, expectedRevision: 0 });
  expect(created.status).toBe(201); expect(created.payload.agent.definition.onboarding).toEqual(onboarding);
  expect((await f.call("GET", `agents/${created.payload.agent.id}`)).payload.agent.definition.onboarding).toEqual(onboarding);
});

test("explicit pause/steering are separate from conversation and preserve submitted update text", async () => {
  const f = await fixture(); const id = (await f.create()).payload.agent.id;
  expect((await f.call("POST", `agents/${id}/actions`, { action: "pause" })).status).toBe(200);
  expect(f.application.pause).toHaveBeenCalledExactlyOnceWith(id);
  expect((await f.call("POST", `agents/${id}/actions`, { action: "steer", text: "Use only the supplied documents." })).status).toBe(200);
  expect(f.application.steer).toHaveBeenCalledExactlyOnceWith(id, { text: "Use only the supplied documents." });
  expect(f.application.send).not.toHaveBeenCalled();
});

test("schedule routes persist explicit finite allowance and fence other Agent ownership", async () => {
  const f = await fixture(); const first = (await f.create("First")).payload.agent.id; const second = (await f.create("Second")).payload.agent.id;
  const body = { id: "timer-1", title: "Check supplied sources", text: "Review the fictional monitor list.", startAt: "2040-01-01T00:00:00.000Z", intervalMs: null, maxOccurrences: 1, limits };
  const result = await f.call("POST", `agents/${first}/schedules`, body);
  expect(result.status).toBe(201); expect(result.payload.schedule).toMatchObject({ agentId: first, status: "active", maxOccurrences: 1, limits, binding: { agentRevision: 1, toolPermissionMode: "ask" } });
  expect((await f.call("GET", `agents/${first}/schedules`)).payload.schedules).toHaveLength(1);
  expect((await f.call("GET", `agents/${second}/schedules`)).payload.schedules).toHaveLength(0);
  expect((await f.call("POST", `agents/${second}/schedules/timer-1/cancel`, { expectedRevision: 1 })).status).toBe(404);
  expect((await f.call("POST", `agents/${first}/schedules/timer-1/cancel`, { expectedRevision: 0 })).status).toBe(409);
  expect((await f.call("POST", `agents/${first}/schedules/timer-1/cancel`, { expectedRevision: 1 })).payload.schedule.status).toBe("cancelled");
  expect(f.application.send).not.toHaveBeenCalled();
});

test("the orbit card marks only accepted work for the current open turn", async () => {
  const f = await fixture();
  const agentId = (await f.create()).payload.agent.id;
  const original = await f.application.detail(agentId);
  const state = await f.store.commitApplication({ kind: "open_agent_turn", agentId, missionId: "current",
    messageId: "chat", text: "Can you help?", intent: "auto", limits, source: null });
  const mission = state.missions.find((entry) => entry.id === "current")!;
  const decisions: AgentApplicationDetail["responsibility"][number][] = [];
  const selected = (action: "answer_user" | "start_session", missionId = mission.id, accepted = true) => ({
    id: "trace", agentId, missionId, agentRevision: original.agent.revision, missionRevision: mission.revision,
    invocationId: "call", plan: { action, reason: "choice", sessionId: null, recipientAgentId: null,
      evidenceIds: [], metCriteriaIds: [] }, accepted, code: accepted ? "accepted" : "rejected", createdAt: mission.createdAt,
  });
  let current = mission;
  vi.spyOn(f.application, "snapshot").mockImplementation(async () => ({
    revision: 1, agents: [{ ...original, mission: current, responsibility: decisions, status: "thinking" }],
  }));
  const hasWork = async () => (await f.call("GET", "agents")).payload.agents[0].hasWork;
  decisions.push(selected("start_session", "old"), selected("start_session", mission.id, false), selected("answer_user"));
  expect(await hasWork()).toBe(false);
  decisions.push(selected("start_session"));
  expect(await hasWork()).toBe(true);
  current = { ...mission, status: "completed" };
  expect(await hasWork()).toBe(false);
});


test("the catalogue dates thinking from direct input and falls back to delegated or scheduled mission start", async () => {
  const f = await fixture();
  const agentId = (await f.create()).payload.agent.id;
  const state = await f.store.commitApplication({ kind: "open_agent_turn", agentId, missionId: "direct", messageId: "hi", text: "Hi", intent: "auto", limits, source: null });
  const detail = await f.application.detail(agentId);
  const origin = state.messages[0]!;
  const messages = [origin];
  let status: AgentApplicationDetail["status"] = "thinking";
  vi.spyOn(f.application, "snapshot").mockImplementation(async () => ({ revision: 1, agents: [{ ...detail, mission: state.missions[0], status, messages }] }));
  const read = async () => (await f.call("GET", "agents")).payload.agents[0].thinkingSince;
  expect(await read()).toBe(origin.createdAt);
  const next = "2040-01-02T00:00:00.000Z";
  messages.push({ ...origin, id: "next", createdAt: next, purpose: "clarification" });
  expect(await read()).toBe(next);
  status = "idle";
  expect(await read()).toBeNull();
  status = "thinking";
  messages[0] = { ...origin, role: "abot", source: { agentId: "abot", missionId: "parent", correlationId: "exchange" } };
  expect(await read()).toBe(next);
  messages.splice(1);
  expect(await read()).toBe(state.missions[0]!.createdAt);
  messages.splice(0, messages.length, { ...origin, id: "schedule", purpose: "request", inputIntent: undefined });
  expect(await read()).toBe(state.missions[0]!.createdAt);
});

test("the catalogue retains public history while its current-mission bubble disappears when approval parks it", async () => {
  const f = await fixture(); const id = (await f.create()).payload.agent.id;
  const base = await f.application.detail(id); const at = new Date().toISOString();
  const request = { agentId: id, missionId: "current", attemptId: "attempt", sessionId: "work", requestId: "request", assignment: "Private assignment", toolPermissionMode: "ask" as const, modelProfileId: "fixture" };
  const attempt = { agentId: id, missionId: "current", id: "attempt", agentRevision: 1, missionRevision: 1, request, mode: "new" as const,
    fingerprint: "f", status: "claimed" as const, claimId: "claim", result: null, outputHash: null, userResolved: false, createdAt: at, updatedAt: at };
  const message = { id: "request-message", role: "user" as const, purpose: "request" as const, source: null, text: "Task", agentId: id, missionId: "current", createdAt: at };
  const detail: AgentApplicationDetail = { ...base, status: "working", mission: { id: "current", agentId: id, revision: 1, objective: "Task", successCriteria: [],
    status: "active", waitingReason: null, limits, usage: { attempts: 1, modelCalls: 0, totalTokens: 0, consecutiveNoProgress: 0, clarificationRounds: 0 }, createdAt: at, updatedAt: at },
    messages: [{ ...message, missionId: "old", id: "old-message" }, message],
    sessions: ["old-session", "work"].map((sessionId) => ({ sessionId, agentId: id, purpose: "Task", createdAt: at })),
    attempts: [{ ...attempt, id: "old", missionId: "old", request: { ...request, missionId: "old", attemptId: "old", sessionId: "old-session", requestId: "old-request" } }, attempt] };
  f.application.snapshot = vi.fn(async () => ({ revision: 3, agents: [detail] }));
  const event = { seqNo: 1, type: "event", requestId: "request", timestamp: at, payload: { name: "user.interaction", generation: "gen", interaction: {
    version: 1, kind: "message", requestId: "request", interactionId: "request:interaction:1", sequence: 1, createdAt: at,
    origin: { callId: "call", activationCount: 1, steeringVersion: 0 }, payload: { text: "The first two sources agree on the price." } } } };
  const session: SessionRecord = { id: "work", title: "Private", createdAt: at, updatedAt: at, messages: [], messageCount: 0, lastAgentMode: "reasoning", requests: [
    { requestId: "request", sessionId: "work", generation: "gen", createdAt: at, updatedAt: at, lastSeqNo: 1, status: "streaming", events: [event] }] };
  f.getSessionById.mockResolvedValue(session);
  const first = await f.call("GET", "agents");
  expect(first.status).toBe(200);
  expect(first.payload.agents[0].latestWorkUpdate).toMatchObject({ missionId: "current", createdAt: at, text: "The first two sources agree on the price." });
  // History reads prior sessions too, but this fixture returns work for old-session.
  // The mismatched record must not produce an old-mission update.
  expect(first.payload.agents[0].recentWorkUpdates).toEqual([first.payload.agents[0].latestWorkUpdate]);
  expect(first.payload.agents[0].recentWorkUpdates).toEqual([
    expect.objectContaining({ missionId: "current", createdAt: at, text: "The first two sources agree on the price." }),
  ]);
  expect(f.application.refresh).not.toHaveBeenCalled();
  session.requests![0]!.status = "completed";
  f.application.snapshot = vi.fn(async () => ({ revision: 3, agents: [{ ...detail, status: "thinking" as const, attempts: [{ ...attempt, status: "settled" as const,
    result: { status: "completed" as const, receiptId: "request:gen:1", error: null, output: "Private result", usage: null } }] }] }));
  expect((await f.call("GET", "agents")).payload.agents[0].latestWorkUpdate).toEqual(first.payload.agents[0].latestWorkUpdate);
  f.application.snapshot = vi.fn(async () => ({ revision: 3, agents: [detail] }));
  session.requests![0]!.status = "awaiting_approval";
  expect((await f.call("GET", "agents")).payload.agents[0].latestWorkUpdate).toBeNull();
  f.application.snapshot = vi.fn(async () => ({ revision: 4, agents: [{ ...detail, status: "awaiting_user_decision" as const }] }));
  const parked = await f.call("GET", "agents");
  expect(parked.status).toBe(200);
  expect(parked.payload.agents[0].latestWorkUpdate).toBeNull();
  expect(parked.payload.agents[0].recentWorkUpdates).toEqual(first.payload.agents[0].recentWorkUpdates);
  expect(f.application.refresh).not.toHaveBeenCalled();
});

test("an unread greeting appears in its Agent catalogue entry, and the scoped read route verifies its source", async () => {
  const notices: AgentReplyNotification[] = [];
  const inbox = { forgetAgentReplies: vi.fn(), recordAgentReply: vi.fn(), unreadAgentReplies: vi.fn(async () => notices), readAgentReplies: vi.fn(async () => { notices.splice(0); }) };
  const f = await fixture(inbox), a = (await f.create("Scout")).payload.agent.id, b = (await f.create("Writer")).payload.agent.id;
  const before = await f.application.detail(a);
  const message = { id: "hello-reply", missionId: "turn", role: "assistant" as const, agentId: a, source: null, createdAt: new Date().toISOString(), text: "היי!" };
  vi.spyOn(f.application, "detail").mockImplementation(async (id) => ({ ...before, agent: { ...before.agent, id }, messages: id === a ? [message] : [] }));
  notices.push({ id: agentReplyId("dev", a, message.id), kind: "reply", title: "Scout replied", body: message.text,
    environmentId: "dev", createdAt: Date.parse(message.createdAt), readAt: null, delivery: { status: "disabled" },
    agentSource: { agentId: a, missionId: "turn", messageId: message.id }, sourceUrl: `/agents?environment=dev&agent=${a}` });
  const getCatalog = async () => (await f.call("GET", "agents")).payload.agents as {id:string; latestUnreadReply: unknown}[];
  const agents = await getCatalog();
  expect(agents.find((entry) => entry.id === a)?.latestUnreadReply).toMatchObject({ id: message.id, text: "היי!" });
  expect(agents.find((entry) => entry.id === b)?.latestUnreadReply).toBeNull();
  expect((await f.call("POST", `agents/${b}/read`, { through: message.id })).status).toBe(404);
  expect(inbox.readAgentReplies).not.toHaveBeenCalled();
  expect((await f.call("POST", `agents/${a}/read`, { through: message.id })).status).toBe(200);
  expect(inbox.readAgentReplies).toHaveBeenCalledExactlyOnceWith("dev", [agentReplyId("dev", a, message.id)]);
  expect((await getCatalog()).find((entry) => entry.id === a)?.latestUnreadReply).toBeNull();
});

test("an accepted public report reaches closed and opened Agent chat before a work session is dispatched", async () => {
  const f = await fixture(); const id = (await f.create()).payload.agent.id;
  const base = await f.application.detail(id); const at = new Date().toISOString();
  const detail: AgentApplicationDetail = { ...base, status: "thinking", mission: { id: "m", agentId: id, revision: 1, objective: "Compare offers",
    successCriteria: [], status: "active", waitingReason: null, limits, usage: { attempts: 0, modelCalls: 1, totalTokens: 20, consecutiveNoProgress: 0, clarificationRounds: 0 }, createdAt: at, updatedAt: at },
    messages: [{ id: "user", agentId: id, missionId: "m", role: "user", purpose: "request", source: null, text: "Compare offers", createdAt: at }],
    responsibility: [{ id: "trace", agentId: id, missionId: "m", agentRevision: 1, missionRevision: 1, invocationId: "selection", accepted: true,
      code: "accepted", createdAt: at, plan: { action: "start_session", reason: "PRIVATE REASON", publicUpdate: "אבדוק את המחירים ואשווה את האפשרויות.",
        sessionId: null, recipientAgentId: null, evidenceIds: [], metCriteriaIds: [] } }] };
  f.application.snapshot = vi.fn(async () => ({ revision: 1, agents: [detail] }));
  vi.spyOn(f.application, "detail").mockResolvedValue(detail);
  const catalog = (await f.call("GET", "agents")).payload.agents[0];
  expect(f.application.refresh).not.toHaveBeenCalled();
  const opened = await f.call("GET", `agents/${id}`);
  expect(catalog.latestWorkUpdate).toMatchObject({ missionId: "m", text: detail.responsibility[0]!.plan.publicUpdate });
  expect(opened.payload.updates).toEqual([catalog.latestWorkUpdate]);
  expect(catalog.latestWorkUpdate.text).not.toContain("PRIVATE");
  expect(f.getSessionById).not.toHaveBeenCalled();
  expect(f.application.refresh).not.toHaveBeenCalled();
});

test("Web create and private remote update use the same preview, policy and explicit limits", async () => {
  const f = await fixture();
  const authoring = { modelProfileId: "fixture", name: "Helper", icon: "pebbles-mint", toolPermissionMode: "ask",
    onboarding: { role: "research", outputs: ["summaries"], style: "balanced", asks: [], updates: "needed",
      notes: "Include your sources.", custom: "", color: "mint", budget: "short" } };
  const web = await f.call("POST", "agents/authoring/preview", { authoring });
  expect(web.status).toBe(200);
  const socket = await f.remote({ type: "agents.authoring.preview.request", authoring });
  expect(socket.preview).toEqual(web.payload.preview);
  expect((await f.store.read()).revision).toBe(0);
  const created = await f.call("POST", "agents", { authoring, expectedRevision: 0 });
  expect(created.status).toBe(201);
  const agent = created.payload.agent;
  expect(agent.definition).toMatchObject({ basePrompt: web.payload.preview.basePrompt, defaultLimits: web.payload.preview.limits });
  const edit = { ...authoring, limits, onboarding: { ...authoring.onboarding, style: "concise", budget: "custom" } };
  const expected = await f.call("POST", "agents/authoring/preview", { authoring: edit, targetAgentId: agent.id });
  await f.remote({ type: "agents.update.request", authoring: edit, expectedRevision: 1, targetAgentId: agent.id });
  const read = await f.call("GET", "agents/" + agent.id);
  expect(read.payload.agent.definition).toMatchObject({ basePrompt: expected.payload.preview.basePrompt, defaultLimits: limits });
  await expect(f.remote({ type: "agents.update.request", authoring: { ...edit, toolPermissionMode: "full_plus" },
    targetAgentId: agent.id, expectedRevision: 2 })).rejects.toThrow("agents_permission_denied");
  expect((await f.store.read()).revision).toBe(2);
});

test("system approval and decision notices never masquerade as model replies in the catalogue", async () => {
  const notices: AgentReplyNotification[] = [];
  const inbox = { forgetAgentReplies: vi.fn(), recordAgentReply: vi.fn(), unreadAgentReplies: vi.fn(async () => notices), readAgentReplies: vi.fn() };
  const f = await fixture(inbox), id = (await f.create()).payload.agent.id;
  for (const [kind, prefix] of [["approval", "approval:"], ["failure", "attention:"]] as const) notices.push({
    id: prefix + "event", kind, title: "System notice", body: "Review needed", environmentId: "dev", createdAt: Date.now(),
    readAt: null, delivery: { status: "disabled" }, agentSource: { agentId: id, missionId: "task", messageId: prefix + "event" },
    sourceUrl: `/agents?environment=dev&agent=${id}`,
  });
  expect((await f.call("GET", "agents")).payload.agents[0].latestUnreadReply).toBeNull();
});
