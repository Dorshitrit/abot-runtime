import type { SessionMessage } from "./types.js";

/** Classification shared by persisted projections and model history. */
export function isAssistantInitiativeMessage(message: SessionMessage): boolean {
  if (message.role !== "assistant") return false;
  if (message.source !== "co_worker") return false;
  if (message.initiative?.kind !== "proactive_proposal_v1") return false;
  if (typeof message.initiative.proposalId !== "string") return false;
  return message.initiative.proposalId.length > 0;
}
