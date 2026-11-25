import type { SessionStore } from "../ports.js";
import type { AgentWorkspaceOperations } from "./workspace-client-contracts.js";
import type { AgentApplicationDetail } from "./application-contracts.js";
import { readAgentAuthoring } from "./authoring.js";
import { agentSessionSummaries, publicSessionMessage } from "./workspace-public-view.js";
import { readAgentMissionLimits } from "./record-validation.js";
import { readAgentScheduleInput } from "./schedule-validation.js";
import { readRemoteAgentCommand, readRemoteAgentDefinition, remoteAgentPage, remoteAgentRevision,
  remoteAgentText, requireRemoteAgentMode, type RemoteAgentCommand } from "./remote-workspace-input.js";
import { projectCommittedAgentDetail, projectRemoteAgentDetail, remoteAgentSummary } from "./remote-workspace-view.js";

function optionalLimits(command: RemoteAgentCommand) {
  return command.limits === undefined ? {} : { limits: readAgentMissionLimits(command.limits) };
}
async function remoteAgentAction(workspace: AgentWorkspaceOperations, detail: AgentApplicationDetail, command: RemoteAgentCommand) {
  const id = detail.agent.id;
  if (command.action === "cancel") return workspace.application.cancel(id);
  if (command.action === "pause") return workspace.application.pause(id);
  if (command.action === "archive" || command.action === "restore") {
    await workspace.management[command.action](id, remoteAgentRevision(command.expectedRevision));
    return undefined;
  }
  requireRemoteAgentMode(detail.agent.definition.toolPermissionMode, command.allowedModes);
  if (command.action === "steer") return workspace.application.steer(id, {
    text: remoteAgentText(command.text, 32_000, "text"), ...optionalLimits(command),
  });
  if (command.action === "resume") return workspace.application.resolve(id, {
    action: "continue", text: remoteAgentText(command.text, 32_000, "text"), ...optionalLimits(command),
  });
  throw new Error("agents_input_action");
}
async function remoteAgentSchedules(workspace: AgentWorkspaceOperations, detail: AgentApplicationDetail, command: RemoteAgentCommand) {
  const agentId = detail.agent.id;
  if (command.type === "agents.schedules.list.request") {
    const schedules = await workspace.schedules.list(agentId);
    if (command.local) return { schedules };
    const page = remoteAgentPage(schedules, command, schedule => schedule.id);
    return { schedules: page.items, nextCursor: page.nextCursor };
  }
  const id = remoteAgentText(command.scheduleId, 128, "schedule_id");
  if (command.type === "agents.schedules.cancel.request") {
    return { schedule: await workspace.schedules.cancel(id, remoteAgentRevision(command.expectedRevision), agentId) };
  }
  requireRemoteAgentMode(detail.agent.definition.toolPermissionMode, command.allowedModes);
  const input = readAgentScheduleInput({ id, agentId, title: command.title, text: command.text,
    startAt: command.startAt, intervalMs: command.intervalMs, maxOccurrences: command.maxOccurrences, limits: command.limits });
  if (command.type === "agents.schedules.create.request") return { schedule: await workspace.schedules.create(input) };
  const { id: _id, agentId: _agentId, ...update } = input;
  return { schedule: await workspace.schedules.update(id, remoteAgentRevision(command.expectedRevision), update, agentId) };
}

/** Runs inside the workspace owner's mutation queue; grant checking and admission share that boundary. */
export async function executeRemoteAgentCommand(workspace: AgentWorkspaceOperations, sessions: SessionStore,
  value: Record<string, unknown>, local = false): Promise<Record<string, unknown>> {
  const command = readRemoteAgentCommand(value, local);
  if (command.type === "agents.authoring.preview.request") {
    const input = readAgentAuthoring(command.authoring, true);
    requireRemoteAgentMode(input.toolPermissionMode, command.allowedModes);
    return { preview: await workspace.management.previewAuthoring(input, command.targetAgentId as string | undefined) };
  }
  if (command.type === "agents.list.request") {
    const snapshot = await workspace.application.snapshot();
    const page = local ? { items: snapshot.agents, nextCursor: null } : remoteAgentPage(snapshot.agents, command, detail => detail.agent.id);
    const active = page.items.some(detail => detail.mission?.status === "active" && ["thinking", "working"].includes(detail.status));
    const state = local || active ? await workspace.store.read() : undefined;
    const agents = await Promise.all(page.items.map(detail => remoteAgentSummary(detail, command, sessions, state)));
    return { revision: snapshot.revision, agents, nextCursor: page.nextCursor };
  }
  if (command.type === "agents.create.request") {
    const catalog = await workspace.management.register(readRemoteAgentDefinition(command), remoteAgentRevision(command.expectedRevision));
    // Registration appends to the catalog returned by that exact commit.
    const created = catalog.agents.at(-1);
    if (!created) throw new Error("agents_creation_unconfirmed");
    return projectCommittedAgentDetail(workspace, sessions, created.id, command);
  }
  const agentId = remoteAgentText(command.targetAgentId, local ? 256 : 128, "agent_id");
  if (command.type === "agents.delete.request") {
    await workspace.deletion.remove(agentId, remoteAgentRevision(command.expectedRevision));
    return { deleted: true };
  }
  if (command.type === "agents.approval.decide.request") {
    await workspace.approvals.decide(agentId, command, command.allowedModes);
    return projectCommittedAgentDetail(workspace, sessions, agentId, command);
  }
  const detail = await workspace.application.detail(agentId);
  if (command.type === "agents.detail.request") {
    return projectRemoteAgentDetail(workspace, sessions, detail, command);
  }
  if (command.type === "agents.sessions.request") {
    const page = remoteAgentPage(agentSessionSummaries(detail), command, session => session.sessionId);
    return { revision: (await workspace.store.read()).revision, sessions: page.items, nextCursor: page.nextCursor };
  }
  if (command.type === "agents.session.request") {
    const sessionId = remoteAgentText(command.sessionId, local ? 256 : 128, "session_id");
    if (!detail.sessions.some(session => session.sessionId === sessionId)) throw new Error("agents_session_not_found");
    if (local) {
      const session = await sessions.getSessionSnapshot(sessionId, { includeRequests: true });
      return { session };
    }
    const limit = command.limit ?? 50;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("agents_input_limit");
    const cursor = command.cursor == null ? null : remoteAgentText(command.cursor, 4096, "cursor");
    const snapshot = await sessions.getSessionSnapshot(sessionId, { includeRequests: false, page: { limit: Number(limit), cursor } });
    if (!snapshot || snapshot.sessionId !== sessionId) throw new Error("agents_session_not_found");
    return { session: { sessionId, title: snapshot.title, messages: snapshot.messages.map(publicSessionMessage),
      nextCursor: snapshot.nextCursor, newerCursor: snapshot.newerCursor ?? null } };
  }
  if (command.type.startsWith("agents.schedules.")) return remoteAgentSchedules(workspace, detail, command);
  if (command.type === "agents.update.request") {
    await workspace.management.update(agentId, readRemoteAgentDefinition(command), remoteAgentRevision(command.expectedRevision));
    return projectCommittedAgentDetail(workspace, sessions, agentId, command);
  }
  if (command.type === "agents.action.request") {
    const changed = await remoteAgentAction(workspace, detail, command);
    return projectCommittedAgentDetail(workspace, sessions, agentId, command, changed);
  }
  requireRemoteAgentMode(detail.agent.definition.toolPermissionMode, command.allowedModes);
  const intent = local ? command.intent : command.intent ?? "auto";
  if (intent !== "auto" && intent !== "task" && intent !== "message") throw new Error("agents_input_intent");
  const admitted = await workspace.application.send(agentId, {
    messageId: remoteAgentText(command.clientMessageId, local ? 256 : 128, "message_id"),
    text: remoteAgentText(command.text, 32_000, "text"), intent, ...optionalLimits(command),
  });
  return projectCommittedAgentDetail(workspace, sessions, agentId, command, admitted);
}
