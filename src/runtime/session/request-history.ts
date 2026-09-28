import type { SessionMessage, SessionRecord } from "../../sessions/types.js";
import type { RequestHistoryMessage } from "../context/request-context-contracts.js";
import { isAssistantInitiativeMessage } from "../../sessions/assistant-initiative.js";

export function snapshotRequestHistory(
  session: SessionRecord,
): RequestHistoryMessage[] {
  return session.messages.filter(isRequestHistoryMessage).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(message.grounding ? { grounding: message.grounding } : {}),
    ...(isAssistantInitiativeMessage(message)
      ? { assistantInitiativeId: message.initiative!.proposalId }
      : {}),
  }));
}

function isRequestHistoryMessage(message: SessionMessage): boolean {
  return message.kind !== "tool_approval_request";
}
