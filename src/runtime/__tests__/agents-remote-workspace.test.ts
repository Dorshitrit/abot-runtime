import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import type WebSocket from "ws";
import type { AgentApplicationDetail } from "../agents/application-contracts.js";
import type { SessionStore } from "../ports.js";
import { createAgentWorkspaceApprovals } from "../agents/workspace-approvals.js";
import type { AgentWorkspaceClient } from "../agents/workspace-client-contracts.js";
import { createAgentManagementService } from "../agents/management-service.js";
import { createAgentScheduleService } from "../agents/schedule-service.js";
import { executeRemoteAgentCommand } from "../agents/remote-workspace.js";
import { remoteAgentSummary } from "../agents/remote-workspace-view.js";
import { handleAgentsBridgeMessage } from "../../bridge/agents-access.js";
import { agentMissionLimits } from "./support/agents-foundation-fixture.js";
import { agentApplicationFixture, disposeAgentApplicationFixtures } from "./support/agents-application-fixture.js";

afterEach(disposeAgentApplicationFixtures);
async function fixture() {
  const f = await agentApplicationFixture();
  const snapshot = vi.fn(async (sessionId: string) => ({ sessionId, title: "Work", messages: [] as Record<string, unknown>[], requests: [], nextCursor: null }));
  const sessions = { getSessionById: vi.fn(async () => null), getSessionSnapshot: snapshot } as unknown as SessionStore;
  const workspace = {
    store: f.store, application: f.app, management: createAgentManagementService(f.store, f.dependencies.config),
    schedules: createAgentScheduleService({ filename: join(f.dependencies.config.paths.runtimeDir, "agents", "schedules.json"), application: f.app }),
    approvals: createAgentWorkspaceApprovals(f.app, {listApprovals: vi.fn(async () => []), decideApproval: vi.fn(async () => ({ accepted: true as const }))}, sessions),
    projection: { attention: async () => ({revision: 0, cursors: [], entries: []}), through: async () => [], pending: async () => [], acknowledge: vi.fn(async () => {}) },
    deletion: { remove: vi.fn(async () => {}) }, isBusy: async () => f.app.isBusy(),
    local: (command: Record<string, unknown>): Promise<Record<string, unknown>> => executeRemoteAgentCommand(workspace, sessions, command, true),
    remote: (command: Record<string, unknown>): Promise<Record<string, unknown>> => executeRemoteAgentCommand(workspace, sessions, command),
  } satisfies AgentWorkspaceClient;
  const call = (type: string, body: Record<string, unknown> = {}) => workspace.remote({
    type: `agents.${type}.request`, allowedModes: ["ask"], targetAgentId: "agent-a", ...body,
  });
  return { ...f, workspace, sessions, snapshot, call };
}
test("remote admission retains message identity across a lost reply and returns the final public conversation", async () => {
  const f = await fixture();
  await f.call("message.send", { clientMessageId: "mobile-message", text: "Check the supplied comparison." });
  await f.app.whenIdle();
  const before = await f.store.read();
  await f.call("message.send", { clientMessageId: "mobile-message", text: "Check the supplied comparison." });
  await f.app.whenIdle();
  const after = await f.store.read();
  expect(after.messages.filter(message => message.id === "mobile-message")).toHaveLength(1);
  expect(after.attempts).toHaveLength(1);
  expect(f.run).toHaveBeenCalledOnce();
  expect(after.missions).toEqual(before.missions);
  const detail = await f.call("detail");
  expect(detail).toMatchObject({ agent: { id: "agent-a" }, mission: { status: "completed" } });
  expect((detail.messages as { role: string }[]).some(message => message.role === "assistant")).toBe(true);
  for (const privateField of ["decisions", "responsibility", "mailbox", "attempts", "invocations"]) expect(detail).not.toHaveProperty(privateField);
});
test("runtime independently rejects unknown fields, missing grants and authority escalation before model invocation", async () => {
  const f = await fixture();
  const agent = (await f.store.read()).agents[0]!;
  await f.store.commitApplication({ kind: "update_definition", agentId: agent.id,
    definition: { ...agent.definition, toolPermissionMode: "full_plus" } });
  await expect(f.call("message.send", { clientMessageId: "m", text: "Do work" })).rejects.toThrow("agents_permission_denied");
  await expect(f.call("message.send", { clientMessageId: "m", text: "Do work", allowedModes: ["full_plus"] })).rejects.toThrow("agents_permission_denied");
  await expect(f.call("message.send", { clientMessageId: "m", text: "Do work", allowedModes: undefined })).rejects.toThrow("agents_permission_required");
  await expect(f.call("detail", { environment: "other" })).rejects.toThrow("agents_input_fields");
  const refresh = vi.spyOn(f.app, "refresh");
  await f.call("detail");
  await f.workspace.local({ type: "agents.detail.request", targetAgentId: agent.id });
  await expect(f.workspace.local({ type: "agents.list.request", allowedModes: ["full_plus"] })).rejects.toThrow("agents_input_fields");
  await expect(f.call("detail", {local: true})).rejects.toThrow("agents_input_fields");
  expect(refresh).not.toHaveBeenCalled();
  await expect(f.call("approval.decide", { approved: false, approvalId: "a", commandId: "orphan" })).rejects.toThrow("agents_input_approval_identity");
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
test("the remote catalog is paged without internal configuration and unknown cursors fail clearly", async () => {
  const f = await fixture();
  const definition = (await f.store.read()).agents[0]!.definition;
  await f.store.commitApplication({ kind: "register_agent", agentId: "agent-b", definition });
  const first = await f.workspace.remote({ type: "agents.list.request", allowedModes: ["ask"], limit: 1 });
  expect(first).toMatchObject({ agents: [{ id: "agent-a" }], nextCursor: "agent-a" });
  expect(JSON.stringify(first)).not.toContain(definition.basePrompt);
  const next = await f.workspace.remote({ type: "agents.list.request", allowedModes: ["ask"], limit: 1, cursor: first.nextCursor });
  expect(next).toMatchObject({ agents: [{ id: "agent-b" }], nextCursor: null });
  await expect(f.workspace.remote({ type: "agents.list.request", allowedModes: ["ask"], cursor: "missing" })).rejects.toThrow("agents_input_cursor");
});
test("owned work previews use bounded pages and never return another Agent's session", async () => {
  const f = await fixture();
  await f.store.commitApplication({ kind: "bind_session", agentId: "agent-a", sessionId: "work-a", purpose: "Task evidence" });
  await expect(f.call("session", { sessionId: "ordinary" })).rejects.toThrow("agents_session_not_found");
  expect(f.snapshot).not.toHaveBeenCalled();
  f.snapshot.mockResolvedValueOnce({ sessionId: "work-a", title: "Work", requests: [], nextCursor: null,
    messages: [{ id: 1, sessionId: "work-a", role: "user", text: "Read this", createdAt: 10, source: "user",
      attachments: [{ id: "file", kind: "file", mimeType: "text/plain", name: "note.txt", size: 7, storageRef: "private/location" }],
      initiative: { kind: "update", reason: "Completed", source: "private/origin" } }] });
  const preview = await f.call("session", { sessionId: "work-a", limit: 10, cursor: "opaque" });
  expect(preview.session).toMatchObject({ messages: [{ text: "Read this", attachments: [{ name: "note.txt" }], initiative: { reason: "Completed" } }] });
  expect(JSON.stringify(preview)).not.toContain("private/");
  expect(f.snapshot).toHaveBeenCalledExactlyOnceWith("work-a", { includeRequests: false, page: { limit: 10, cursor: "opaque" } });
});
test("private delegation correspondence and model rationale do not enter the public Agent conversation", async () => {
  const f = await fixture();
  const state = await f.store.read();
  const agent = state.agents[0]!;
  const detail = await f.app.detail(agent.id);
  const base = { agentId: agent.id, missionId: "delegation", createdAt: "2026-11-18T00:00:00.000Z" };
  vi.spyOn(f.app, "detail").mockResolvedValue({
    ...detail, activity: "PRIVATE_RATIONALE",
    mission: { id: "delegation", agentId: agent.id, revision: 1, status: "active", objective: "PRIVATE_OBJECTIVE",
      successCriteria: [{ id: "criterion", description: "PRIVATE_CRITERION" }], waitingReason: null,
      limits: agentMissionLimits(), usage: { attempts: 0, modelCalls: 0, totalTokens: 0, consecutiveNoProgress: 0, clarificationRounds: 0 },
      createdAt: base.createdAt, updatedAt: base.createdAt },
    messages: [
      { ...base, id: "private-assignment", role: "abot", purpose: "request", source: { agentId: "abot", missionId: "parent", correlationId: "exchange" }, text: "PRIVATE_ASSIGNMENT" },
      { ...base, id: "private-reply", role: "assistant", source: null, text: "PRIVATE_DELEGATION_REPLY" },
      { ...base, id: "user", role: "user", purpose: "conversation", source: null, text: "How is it going?" },
      { ...base, id: "reply:user", role: "assistant", purpose: "reply", source: null, text: "Public update" },
    ],
  });
  const publicView = await f.call("detail", { limit: 1 });
  expect(publicView).toMatchObject({ messages: [{ id: "reply:user", text: "Public update" }], nextBeforeMessageId: "reply:user" });
  expect(JSON.stringify(publicView)).not.toContain("PRIVATE_");
  const webView = await f.workspace.local({ type: "agents.detail.request", targetAgentId: agent.id });
  expect(webView.messages).toMatchObject([{id: "user"}, {id: "reply:user"}]);
  expect(JSON.stringify(webView)).not.toContain("PRIVATE_");
  for (const key of ["responsibility", "attempts", "mailbox"]) expect(webView).not.toHaveProperty(key);
});
test("schedule edits are scoped to the selected Agent and preserve the revision contract", async () => {
  const f = await fixture();
  const limits = (await f.store.read()).agents[0]!.definition.defaultLimits;
  const created = await f.call("schedules.create", { scheduleId: "mobile-schedule", title: "Follow up",
    text: "Check the result again", startAt: new Date(Date.now() + 60_000).toISOString(), intervalMs: null, maxOccurrences: 1, limits });
  expect(created.schedule).toMatchObject({ agentId: "agent-a", id: "mobile-schedule", status: "active" });
  await expect(f.call("schedules.cancel", { scheduleId: "mobile-schedule", expectedRevision: 99 })).rejects.toThrow("agents_schedule_revision_conflict");
  expect(await f.call("schedules.cancel", { scheduleId: "mobile-schedule", expectedRevision: 1 })).toMatchObject({ schedule: { status: "cancelled" } });
});
test("an admitted mutation is acknowledged when fetching its follow-up view fails", async () => {
  const f = await fixture();
  const original = await f.app.detail("agent-a");
  const definition = { name: "Updated", icon: original.agent.definition.icon, basePrompt: "An updated Agent",
    modelProfileId: original.agent.definition.modelProfileId, toolPermissionMode: "ask" };
  vi.spyOn(f.app, "detail").mockResolvedValueOnce(original).mockRejectedValueOnce(new Error("read unavailable"));
  const result = await f.call("update", { definition, limits: original.agent.definition.defaultLimits,
    expectedRevision: original.agent.revision });
  expect(result).toEqual({ acknowledged: true, needsRefetch: true, targetAgentId: "agent-a" });
  expect((await f.store.read()).agents[0]?.definition.name).toBe("Updated");
});

test("a failed follow-up read returns the ID of the newly created Agent", async () => {
  const f = await fixture();
  const { agent } = await f.app.detail("agent-a");
  const { name, icon, basePrompt, modelProfileId, toolPermissionMode, defaultLimits } = agent.definition;
  const { revision } = await f.store.read();
  const read = vi.spyOn(f.app, "detail").mockRejectedValueOnce(new Error("read unavailable"));
  const receipt = await f.workspace.local({ type: "agents.create.request",
    definition: { name, icon, basePrompt, modelProfileId, toolPermissionMode }, limits: defaultLimits, expectedRevision: revision });
  const saved = await f.store.read();
  expect(saved.agents).toHaveLength(2);
  const created = saved.agents.find(record => record.id !== agent.id)!;
  expect(read).toHaveBeenCalledWith(created.id);
  expect(receipt).toEqual({ acknowledged: true, needsRefetch: true, targetAgentId: created.id });
});

test("a large committed response returns a receipt while an oversized read reports its limit", async () => {
  const frames: Record<string, unknown>[] = [];
  const socket = { send: (raw: string) => { frames.push(JSON.parse(raw)); } } as unknown as WebSocket;
  const remote = async () => ({ agent: { id: "agent-a" }, text: "א".repeat(600_000) });
  await handleAgentsBridgeMessage(socket, { type: "agents.create.request", correlationId: "create" }, { remote });
  await handleAgentsBridgeMessage(socket, { type: "agents.detail.request", correlationId: "read", targetAgentId: "agent-a" }, { remote });
  expect(frames[0]).toMatchObject({ ok: true, data: { acknowledged: true, needsRefetch: true, targetAgentId: "agent-a" } });
  expect(frames[1]).toMatchObject({ ok: false, error: "agents_response_too_large" });
});

test("bridge binds responses to the Agent/message and sanitizes errors without leaking service internals", async () => {
  const frames: Record<string, unknown>[] = [];
  const socket = { send: (raw: string) => { frames.push(JSON.parse(raw)); } } as unknown as WebSocket;
  const remote = vi.fn(async () => { throw new Error("/private/secret/token"); });
  await handleAgentsBridgeMessage(socket, { type: "agents.message.send.request", targetAgentId: "agent-a", clientMessageId: "mobile",
    text: "Hello", allowedModes: ["ask"], correlationId: "correlation" }, { remote });
  expect(frames[0]).toEqual({ type: "agents.message.send.response", targetAgentId: "agent-a", clientMessageId: "mobile",
    correlationId: "correlation", ok: false, error: "agents_service_unavailable" });
  expect(remote).toHaveBeenCalledWith(expect.not.objectContaining({ correlationId: "correlation" }));
  await handleAgentsBridgeMessage(socket, { type: "agents.detail.request", correlationId: "next", targetAgentId: "agent-a" }, undefined);
  expect(frames[1]).toMatchObject({ ok: false, error: "agents_unsupported" });
});


test("remote and Web catalogs share current public work without another per-Agent read or private context", async () => {
  const f = await fixture();
  const original = await f.app.detail("agent-a"), at = "2026-11-18T15:26:44.000Z";
  const detail: AgentApplicationDetail = { ...original, status: "working", mission: {
    id: "current", agentId: original.agent.id, revision: 1, status: "active", objective: "PRIVATE_OBJECTIVE", successCriteria: [],
    waitingReason: null, limits: agentMissionLimits(), usage: { attempts: 0, modelCalls: 0, totalTokens: 0, consecutiveNoProgress: 0, clarificationRounds: 0 },
    createdAt: at, updatedAt: at }, messages: [
      { id: "older-reply", agentId: original.agent.id, missionId: "older", role: "assistant", purpose: "reply", text: "Previous answer", source: null, createdAt: at },
      { id: "input", agentId: original.agent.id, missionId: "current", role: "user", purpose: "request", inputIntent: "auto", text: "PRIVATE_REQUEST", source: null, createdAt: at },
    ], responsibility: [{ id: "trace", agentId: original.agent.id, missionId: "current", agentRevision: 1, missionRevision: 1,
      invocationId: "decision", accepted: true, code: "accepted", createdAt: at,
      plan: { action: "start_session", publicUpdate: "Checking the available sources.", reason: "PRIVATE_RATIONALE", sessionId: null,
        recipientAgentId: null, evidenceIds: [], metCriteriaIds: [] } }] };
  vi.spyOn(f.app, "snapshot").mockResolvedValue({ revision: 12, agents: [detail] });
  const refresh = vi.spyOn(f.app, "refresh"), reads = vi.spyOn(f.app, "detail");
  const remote = await f.workspace.remote({ type: "agents.list.request", allowedModes: ["ask"] });
  const web = await f.workspace.local({ type: "agents.list.request" });
  const summary = (remote.agents as Record<string, unknown>[])[0]!;
  expect(summary).toMatchObject({ mission: { id: "current", status: "active" },
    latestWorkUpdate: { missionId: "current", text: "Checking the available sources.", createdAt: at },
    latestReply: { id: "older-reply", missionId: "older", text: "Previous answer" } });
  expect(summary).not.toHaveProperty("recentWorkUpdates");
  expect((web.agents as Record<string, unknown>[])[0]!.recentWorkUpdates).toEqual([summary.latestWorkUpdate]);
  expect(summary.mission).toEqual({ id: "current", status: "active" });
  expect(summary.latestWorkUpdate).toEqual((web.agents as Record<string, unknown>[])[0]!.latestWorkUpdate);
  expect(JSON.stringify(remote)).not.toContain("PRIVATE_");
  expect(reads).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
  vi.mocked(f.app.snapshot).mockResolvedValue({ revision: 13, agents: [{ ...detail, status: "thinking", responsibility: [],
    messages: [{ ...detail.messages[1]!, role: "abot", source: { agentId: "coordinator", missionId: "parent", correlationId: "exchange" } }] }] });
  const delegated = await f.workspace.remote({ type: "agents.list.request", allowedModes: ["ask"] });
  expect((delegated.agents as Record<string, unknown>[])[0]).toMatchObject({ thinkingSince: at, hasWork: false, latestWorkUpdate: null });
  expect(JSON.stringify(delegated)).not.toContain("PRIVATE_");
  vi.mocked(f.app.snapshot).mockResolvedValue({ revision: 13, agents: [{ ...detail, status: "idle", mission: { ...detail.mission!, status: "completed" } }] });
  const completed = await f.workspace.remote({ type: "agents.list.request", allowedModes: ["ask"] });
  expect((completed.agents as Record<string, unknown>[])[0]).toMatchObject({ mission: { id: "current", status: "completed" }, latestWorkUpdate: null, thinkingSince: null });
  const completedWeb = await f.workspace.local({ type: "agents.list.request" });
  expect((completedWeb.agents as Record<string, unknown>[])[0]).toMatchObject({
    latestWorkUpdate: null, recentWorkUpdates: [summary.latestWorkUpdate],
  });

  // Each retained published mission contributes a public admission, never its private rationale.
  const messages = Array.from({ length: 13 }, (_, i) => ({ ...detail.messages[1]!,
    id: 'input-' + i, missionId: 'history-' + i }));
  const responsibility = messages.map((message, i) => ({ ...detail.responsibility[0]!,
    id: 'trace-' + String(i).padStart(2, '0'), missionId: message.missionId,
    createdAt: new Date(Date.parse(at) + Math.floor(i / 2) * 1000).toISOString(),
    plan: { ...detail.responsibility[0]!.plan, publicUpdate: 'Public progress ' + i },
  }));
  const history: AgentApplicationDetail = { ...detail, status: "idle",
    mission: { ...detail.mission!, status: "completed" }, messages,
    responsibility: [...responsibility].reverse().concat(responsibility[0]!),
  };
  vi.mocked(f.app.snapshot).mockResolvedValue({ revision: 14, agents: [history] });
  const firstHistory = await f.workspace.local({ type: "agents.list.request" });
  const repeatedHistory = await f.workspace.local({ type: "agents.list.request" });
  const firstAgent = (firstHistory.agents as Record<string, unknown>[])[0]!;
  const updates = firstAgent.recentWorkUpdates as { id: string; text: string; createdAt: string }[];
  expect(updates).toHaveLength(10);
  expect(new Set(updates.map(update => update.id)).size).toBe(10);
  const expected = responsibility.map(trace => ({
    id: JSON.stringify(["agent-update", trace.missionId, trace.id, "admission"]),
    missionId: trace.missionId, text: trace.plan.publicUpdate, createdAt: trace.createdAt,
  })).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 10);
  expect(updates).toEqual(expected);
  expect((repeatedHistory.agents as Record<string, unknown>[])[0]!.recentWorkUpdates).toEqual(updates);
  expect(firstAgent.latestWorkUpdate).toBeNull();
  expect(JSON.stringify(updates)).not.toContain("PRIVATE_");
  const remoteHistory = await f.workspace.remote({ type: "agents.list.request", allowedModes: ["ask"] });
  expect((remoteHistory.agents as Record<string, unknown>[])[0]).not.toHaveProperty("recentWorkUpdates");
  expect(f.workspace.projection.acknowledge).not.toHaveBeenCalled();
  const state = await f.store.read();
  const localCommand = { type: "agents.list.request", local: true } as Parameters<typeof remoteAgentSummary>[1];
  expect(await remoteAgentSummary(history, localCommand, f.sessions)).toHaveProperty("recentWorkUpdates", []);
  expect(await remoteAgentSummary({ ...history, isDeleting: true }, localCommand, f.sessions, state))
    .toHaveProperty("recentWorkUpdates", []);
  expect(await remoteAgentSummary({ ...history, agent: { ...history.agent, status: "archived" } }, localCommand, f.sessions, state))
    .toHaveProperty("recentWorkUpdates", []);
  expect(await remoteAgentSummary({ ...history, messages: [], responsibility: [] }, localCommand, f.sessions, state))
    .toHaveProperty("recentWorkUpdates", []);
});
