import { emptyAgentNotificationCursor, type AgentNotificationPage, type AgentNotificationCursor } from "../../runtime/agents/notification-attention.js";
import { NOTIFICATION_RETENTION_MS } from "../notifications/retention.js";
import { notificationIdentity } from "../notifications/identity.js";
import type { AgentNotificationInbox } from "./agent-chat-notifications.js";

type ReadNotifications = (cursor: AgentNotificationCursor, since: number) => Promise<AgentNotificationPage>;
const approvalPrefix = "approval:";

/** Public Runtime waits use the same durable identity in Web and Socket delivery. */
export function createAgentAttentionObserver(environment: string, inbox: AgentNotificationInbox, openedAt = Date.now()) {
  let cursor = emptyAgentNotificationCursor();
  return async (read: ReadNotifications) => {
    let page: AgentNotificationPage;
    do {
      page = await read(cursor, Date.now() - NOTIFICATION_RETENTION_MS);
      for (const entry of page.entries) {
        if (entry.reason !== "attention") continue;
        const approval = entry.attentionKind === "approval", budget = entry.attentionKind === "budget";
        const kind = approval ? "approval" : "failure";
        const messageId = `${approval ? approvalPrefix : "attention:"}${entry.eventId}`;
        await inbox.recordAgentReply({
          id: notificationIdentity(environment, kind, messageId), kind,
          title: `${entry.agentName || "Agent"} ${approval ? "needs your approval" : budget ? "reached its task budget" : "needs your decision"}`,
          body: approval ? "A work session is waiting. Open the agent to review the requested action." : budget ? "The task stopped at its configured limit. Open the agent to review the task and any saved work." : "Open the agent to review the paused task.",
          agentSource: { agentId: entry.targetAgentId, missionId: entry.missionId, messageId },
          environmentId: environment, sourceUrl: `/agents?${new URLSearchParams({ environment, agent: entry.targetAgentId })}`,
          createdAt: entry.createdAt, readAt: null, delivery: { status: "disabled" },
        }, entry.createdAt < openedAt);
      }
      cursor = page.cursor;
    } while (cursor.delivered?.length);
    // A resolved wait is no longer actionable, including after Web restart. Never mark a later wait read.
    const active = new Set(cursor.approvals ?? []);
    const resolved = (await inbox.unreadAgentReplies(environment)).filter(item => item.kind === "approval" &&
      item.agentSource.messageId.startsWith(approvalPrefix) && !active.has(item.agentSource.messageId.slice(approvalPrefix.length)));
    if (resolved.length) await inbox.readAgentReplies(environment, resolved.map(item => item.id));
  };
}
