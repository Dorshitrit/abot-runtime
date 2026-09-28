export function sparkProposalId(message) {
  if (message?.role !== "assistant" || message?.source !== "co_worker") return "";
  if (message.initiative?.kind !== "proactive_proposal_v1") return "";
  const id = message.initiative.proposalId;
  return typeof id === "string" ? id.trim() : "";
}
