export function sparkProposalId(message) {
  if (message?.role !== "assistant" || message?.source !== "co_worker") return "";
  if (message.initiative?.kind !== "proactive_proposal_v1") return "";
  const id = message.initiative.proposalId;
  return typeof id === "string" ? id.trim() : "";
}

export function sparkHandoffAvailable(message) {
  if (!sparkProposalId(message)) return false;
  const { handoffBrief, handoffTitle } = message.initiative;
  if (typeof handoffBrief !== "string" || !handoffBrief.trim() || handoffBrief.length > 4000) return false;
  return typeof handoffTitle === "string" && Boolean(handoffTitle.trim()) && handoffTitle.length <= 160;
}
