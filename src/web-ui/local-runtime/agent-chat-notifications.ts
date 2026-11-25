import type { AgentAttentionCursor, AgentAttentionPage } from "../../runtime/agents/attention.js";
import { notificationIdentity } from "../notifications/identity.js";
import { NOTIFICATION_RETENTION_MS } from "../notifications/retention.js";
import type { AgentReplyNotification } from "../notifications/contracts.js";

export type AgentNotificationInbox = {
  recordAgentReply(item: AgentReplyNotification, historical: boolean): Promise<void>;
  unreadAgentReplies(environment: string): Promise<AgentReplyNotification[]>;
  forgetAgentReplies(environment: string, agentId: string): Promise<void>;
  readAgentReplies(environment: string, ids: string[]): Promise<unknown>;
};

export function agentReplyId(environment: string, agentId: string, messageId: string) {
  return notificationIdentity(environment, "reply", JSON.stringify(["agent", agentId, messageId]));
}
const titles = { plan: "needs your decision", exhausted: "stopped before finishing", result: "reported the result",
  completed: "finished the task", question: "has a question", reply: "replied" };
function planningText(recovery: "work_returned" | "no_result" | null) {
  if (recovery === "work_returned") return "The work session returned a result. I paused because I couldn’t verify my next step.";
  if (recovery === "no_result") return "I paused because I couldn’t verify my next step.";
  return "I couldn’t verify the next step. Open the conversation to review the task.";
}
type ReadAttention = (cursors: readonly AgentAttentionCursor[], since: number) => Promise<AgentAttentionPage>;

/** Advance only after all notices were persisted; stable IDs deduplicate a retry or restart. */
export function createAgentReplyObserver(environment: string, inbox: AgentNotificationInbox, openedAt = Date.now()) {
  let cursors: readonly AgentAttentionCursor[] = [];
  return async (read: ReadAttention) => {
    const page = await read(cursors, Date.now() - NOTIFICATION_RETENTION_MS);
    for (const item of page.entries) {
      const { agentId, missionId, messageId } = item;
      await inbox.recordAgentReply({
        id: agentReplyId(environment, agentId, messageId), kind: item.kind === "plan" || item.kind === "exhausted" ? "failure" : "reply",
        title: `${item.agentName} ${titles[item.kind]}`, body: item.kind === "plan" ? planningText(item.recovery) : item.text,
        agentSource: { agentId, missionId, messageId }, environmentId: environment,
        sourceUrl: `/agents?${new URLSearchParams({ environment, agent: agentId })}`, createdAt: item.createdAt,
        readAt: null, delivery: { status: "disabled" },
      }, item.createdAt < openedAt);
    }
    cursors = page.cursors;
    return page.revision;
  };
}
