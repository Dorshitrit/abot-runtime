import type { SessionRecord } from "../../sessions/types.js";
import type { RequestHistoryMessage } from "../context/request-context-contracts.js";

export function snapshotRequestHistory(
  session: SessionRecord,
): RequestHistoryMessage[] {
  return session.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(message.grounding ? { grounding: message.grounding } : {}),
  }));
}
