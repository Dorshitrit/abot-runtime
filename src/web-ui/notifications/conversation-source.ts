import { isSparkSession } from "../../sessions/spark-session.js";
import { toSnapshotMessage } from "../../sessions/record/projection.js";
import type { SessionRecord } from "../../sessions/types.js";

export type NotificationSession = Partial<Pick<SessionRecord, "kind" | "messages" | "requests">> & { automationOrigin?: unknown };

/** Navigation follows the stored session kind; titles never identify SPARK. */
export function conversationNotificationSource(
  environmentId: string, sessionId: string, event: Record<string, unknown>, persisted?: NotificationSession | null,
): string {
  const parameters = new URLSearchParams({ environment: environmentId, session: sessionId });
  if (!persisted || !isSparkSession(persisted)) return `/chat?${parameters}`;
  parameters.delete("session");
  parameters.set("spark", "1");
  const proposal = event.event as Record<string, unknown> | undefined;
  const message = [...(persisted.messages ?? [])].reverse().find((item) => {
    if (item.role !== "assistant") return false;
    if (proposal?.type === "proposal_delivered") return item.initiative?.proposalId === proposal.proposalId;
    return typeof event.requestId === "string" && item.requestId === event.requestId;
  });
  if (message) {
    const reference = toSnapshotMessage(sessionId, message, persisted.requests ?? []);
    parameters.set("message", String(reference.id));
    parameters.set("messageCreatedAt", String(reference.createdAt));
    if (reference.requestId) parameters.set("request", reference.requestId);
  }
  return `/home?${parameters}`;
}
