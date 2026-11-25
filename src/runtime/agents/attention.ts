import type { AgentMission, AgentState } from "./agent-records.js";
import type { AgentApplicationDetail } from "./application-contracts.js";
import { visibleAgentReplies } from "./conversation-view.js";
import { projectLegacyExhaustionReply } from "./exhaustion-reply.js";
import type { AgentWorkAttempt } from "./workspace-records.js";

export type AgentAttentionCursor = Readonly<{ agentId: string; messages: number; traces: number }>;
type Kind = "plan" | "exhausted" | "result" | "completed" | "question" | "reply";
type Entry = Readonly<{ agentId: string; agentName: string; missionId: string; messageId: string; createdAt: number;
  kind: Kind; text: string; recovery: ReturnType<typeof agentPlanRecoveryStatus> }>;
export type AgentAttentionPage = Readonly<{ revision: number; cursors: readonly AgentAttentionCursor[]; entries: readonly Entry[] }>;

export function agentPlanRecoveryStatus(mission: AgentMission | null, attempts: readonly AgentWorkAttempt[]): "work_returned" | "no_result" | null {
  if (mission?.status !== "awaiting_user_decision" || mission.waitingReason !== "agents_plan_invalid") return null;
  return attempts.some(attempt => attempt.agentId === mission.agentId && attempt.missionId === mission.id &&
    attempt.status === "settled" && attempt.result?.status === "completed") ? "work_returned" : "no_result";
}
type Sources = Pick<AgentApplicationDetail, "messages" | "responsibility">;
function attentionEntries(sources: Sources, agentId: string) {
  const direct = new Set(sources.messages.filter(message => message.agentId === agentId && message.role === "user" &&
    !message.source && message.purpose === "request").map(message => message.missionId));
  const notices = sources.responsibility.filter(trace => trace.agentId === agentId && !trace.accepted &&
    trace.code === "malformed_proposal" && direct.has(trace.missionId)).map(trace => ({
      id: `plan-notice:${trace.id}`, missionId: trace.missionId, createdAt: trace.createdAt, planningNotice: true,
    }));
  return [...visibleAgentReplies(sources.messages, agentId), ...notices].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
export function latestAgentAttentionId(detail: AgentApplicationDetail): string | null {
  return attentionEntries(detail, detail.agent.id).at(-1)?.id ?? null;
}
export function latestPlanNoticeId(detail: AgentApplicationDetail): string | null {
  return attentionEntries(detail, detail.agent.id).filter(m => "planningNotice" in m && m.missionId === detail.mission?.id).at(-1)?.id ?? null;
}
export function attentionMessageIdsThrough(detail: AgentApplicationDetail, through: string): string[] {
  const entries = attentionEntries(detail, detail.agent.id);
  const index = entries.findIndex(entry => entry.id === through);
  if (index < 0) throw new Error("agents_message_not_found");
  return entries.slice(Math.max(0, index - 999), index + 1).map(entry => entry.id);
}
function preview(text: string): string {
  return [...text.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim()].slice(0, 600).join("");
}
/** Return only public attention records added since each agent's last observed cursor. */
export function projectAgentAttention(state: AgentState, cursors: readonly AgentAttentionCursor[], since: number): AgentAttentionPage {
  const previous = new Map(cursors.map(cursor => [cursor.agentId, cursor]));
  const next: AgentAttentionCursor[] = [], entries: Entry[] = [];
  const missions = new Map(state.missions.map(mission => [mission.id, mission]));
  const work = new Set([...state.attempts, ...state.mailbox].map(entry => entry.missionId));
  for (const agent of state.agents) {
    if (state.deletingAgentIds.includes(agent.id)) continue;
    const scoped = { messages: state.messages.filter(m => m.agentId === agent.id),
      responsibility: state.responsibility.filter(t => t.agentId === agent.id) };
    const prior = previous.get(agent.id);
    next.push({ agentId: agent.id, messages: scoped.messages.length, traces: scoped.responsibility.length });
    if (prior?.messages === scoped.messages.length && prior.traces === scoped.responsibility.length) continue;
    const added = new Set([...scoped.messages.slice(prior?.messages ?? 0).map(m => m.id),
      ...scoped.responsibility.slice(prior?.traces ?? 0).map(trace => `plan-notice:${trace.id}`)]);
    const reported = new Set(scoped.responsibility.filter(trace => trace.plan.action === "answer_user" &&
      trace.plan.evidenceIds.length === 1 && (trace.accepted || trace.code === "work_requires_acceptance")).map(trace => trace.missionId));
    const messages = attentionEntries(scoped, agent.id);
    const latest = new Map(messages.map(message => [message.missionId, message.id]));
    for (const message of messages) {
      if (!added.has(message.id)) continue;
      const mission = missions.get(message.missionId), at = Date.parse(message.createdAt);
      if (!mission || at <= since) continue;
      const terminal = ["exhausted", "completed"].includes(mission.status) && latest.get(mission.id) === message.id;
      let kind: Kind = "reply", text = "", recovery: Entry["recovery"] = null;
      if ("planningNotice" in message) {
        kind = "plan";
        recovery = agentPlanRecoveryStatus(mission, state.attempts);
      } else {
        text = preview(projectLegacyExhaustionReply(state, message).text);
        if (terminal && mission.status === "exhausted") kind = "exhausted";
        else if (terminal && reported.has(mission.id)) kind = "result";
        else if (terminal && work.has(mission.id)) kind = "completed";
        else if (message.purpose === "question") kind = "question";
      }
      entries.push({ agentId: agent.id, agentName: agent.definition.name, missionId: mission.id, messageId: message.id, createdAt: at, kind, text, recovery });
    }
  }
  return { revision: state.revision, cursors: next, entries };
}
