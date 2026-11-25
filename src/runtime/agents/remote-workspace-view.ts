import { agentClientStatus, agentSessionSummaries, latestVisibleReply, publicApproval } from "./workspace-public-view.js";
import { visibleAgentReplies } from "./conversation-view.js";
import type { AgentApplicationDetail } from "./application-contracts.js";
import type { AgentState } from "./agent-records.js";
import type { AgentWorkspaceOperations } from "./workspace-client-contracts.js";
import type { SessionStore } from "../ports.js";
import { createAgentChatUpdates } from "./chat-updates.js";
import { AGENT_REMOTE_RESPONSE_BYTES, remoteAgentModeAllowed, remoteAgentText, type RemoteAgentCommand } from "./remote-workspace-input.js";

function visibleRemoteMessages(detail: AgentApplicationDetail, local = false) {
  const delegated = new Set(detail.messages.filter(message => message.role === "abot" && message.source && message.purpose !== "clarification")
    .map(message => message.missionId));
  const replies = new Set(visibleAgentReplies(detail.messages, detail.agent.id).map(message => message.id));
  return detail.messages.filter(message => {
    if (message.agentId !== detail.agent.id || message.role === "abot") return false;
    if (message.role === "assistant") return replies.has(message.id);
    if (!delegated.has(message.missionId)) return true;
    return message.role === "user" && message.purpose === "conversation";
  }).map(({ id, agentId, missionId, role, purpose, text, createdAt, inputIntent, source }) =>
    ({ id, agentId, missionId, role, purpose, text, createdAt, inputIntent, ...(local && role === "user" && !source && !delegated.has(missionId) && { directInput: true }) }));
}
function visibleMission(detail: AgentApplicationDetail) {
  const mission = detail.mission;
  const delegated = mission && detail.messages.some(message => message.missionId === mission.id &&
    message.role === "abot" && message.source && message.purpose !== "clarification");
  return delegated ? { id: mission.id, agentId: mission.agentId, revision: mission.revision,
    status: mission.status, createdAt: mission.createdAt, updatedAt: mission.updatedAt } : mission;
}
const updatesByStore = new WeakMap<SessionStore, ReturnType<typeof createAgentChatUpdates>>();
function progress(sessions: SessionStore) {
  let project = updatesByStore.get(sessions);
  if (!project) { project = createAgentChatUpdates(sessions); updatesByStore.set(sessions, project); }
  return project;
}

export async function remoteAgentSummary(detail: AgentApplicationDetail, command: RemoteAgentCommand,
  sessions: SessionStore, state?: AgentState) {
  const { agent } = detail;
  const reply = latestVisibleReply(detail);
  const status = agentClientStatus(detail);
  const latestWorkUpdate = state ? await progress(sessions).latest(detail, state) : null;
  // Retained public history is local-only; latestWorkUpdate remains active-mission scoped.
  const recentWorkUpdates = command.local && state && agent.status !== "archived" && !detail.isDeleting
    ? await progress(sessions).recent(detail, state) : [];
  const workStatus = detail.status;
  if (command.local) return { ...agent, ...status, isDeleting: detail.isDeleting === true, sessionCount: detail.sessions.length,
    workStatus, ...(detail.approvalAttention && { approvalAttention: detail.approvalAttention }),
    ...(detail.mission && detail.recovery.budgetStopReason && { budgetStop: { missionId: detail.mission.id,
      reason: detail.recovery.budgetStopReason, stopping: detail.recovery.budgetStopping === true } }), mission: visibleMission(detail), activity: latestWorkUpdate?.text ?? null, latestWorkUpdate, recentWorkUpdates, latestAgentMessage: reply?.text ?? null,
    limits: agent.definition.defaultLimits ?? null };
  return { id: agent.id, name: agent.definition.name, icon: agent.definition.icon, modelProfileId: agent.definition.modelProfileId,
    toolPermissionMode: agent.definition.toolPermissionMode, status: agent.status, workStatus, sessionCount: detail.sessions.length,
    isDeleting: detail.isDeleting === true, hasWork: status.hasWork, thinkingSince: status.thinkingSince,
    mission: detail.mission ? { id: detail.mission.id, status: detail.mission.status } : null, latestWorkUpdate,
    canSend: remoteAgentModeAllowed(agent.definition.toolPermissionMode, command.allowedModes), latestReply: reply };
}

/** Only user conversation, public updates, and explicit task state cross the network. */
export async function projectRemoteAgentDetail(workspace: AgentWorkspaceOperations, sessions: SessionStore,
  detail: AgentApplicationDetail, command: RemoteAgentCommand, state?: AgentState) {
  const snapshot = state ?? await workspace.store.read();
  const all = visibleRemoteMessages(detail, command.local);
  const limit = command.limit ?? 50;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("agents_input_limit");
  const before = command.beforeMessageId;
  const end = before == null ? all.length : all.findIndex(message => message.id === remoteAgentText(before, 256, "message_id"));
  if (end < 0) throw new Error("agents_input_cursor");
  const start = command.local ? 0 : Math.max(0, end - Number(limit));
  const messages = all.slice(start, end);
  const reports = await progress(sessions)(detail, snapshot);
  const updates = command.local ? reports : reports.slice(-100);
  const approvals = (await workspace.approvals.list(detail.agent.id)).map(publicApproval);
  return { ...agentClientStatus(detail), revision: snapshot.revision, agent: detail.agent, status: detail.status,
    ...(command.local && { sessions: agentSessionSummaries(detail), limits: detail.agent.definition.defaultLimits ?? null }),
    ...(command.local && detail.approvalAttention && { approvalAttention: detail.approvalAttention }),
    activity: updates.at(-1)?.text ?? null, mission: visibleMission(detail), messages, updates, approvals,
    recovery: detail.recovery, isDeleting: detail.isDeleting === true,
    replyingToMessageIds: detail.replyingToMessageIds ?? [], pendingUserQuestionId: detail.pendingUserQuestionId ?? null,
    canSend: remoteAgentModeAllowed(detail.agent.definition.toolPermissionMode, command.allowedModes),
    nextBeforeMessageId: start > 0 ? messages[0]!.id : null };
}

/** A failed read after admission must not tell the caller to repeat a committed action. */
export async function projectCommittedAgentDetail(workspace: AgentWorkspaceOperations, sessions: SessionStore,
  agentId: string, command: RemoteAgentCommand, detail?: AgentApplicationDetail) {
  try {
    const view = await projectRemoteAgentDetail(workspace, sessions, detail ?? await workspace.application.detail(agentId), command);
    if (command.local || Buffer.byteLength(JSON.stringify(view)) <= AGENT_REMOTE_RESPONSE_BYTES - 2048) return view;
    return { acknowledged: true, needsRefetch: true, targetAgentId: agentId, revision: view.revision };
  } catch {
    return { acknowledged: true, needsRefetch: true, targetAgentId: agentId };
  }
}
