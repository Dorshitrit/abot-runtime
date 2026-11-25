import { markInvocationContextMessage } from "../../model-gateway/protocol/invocation-context.js";
import type { AgentMission, AgentState } from "./agent-records.js";

/** Only the dispatch that just returned can supply this continuation. The mailbox owns the evidence. */
export function projectReturnedDelegation(state: AgentState, mission: AgentMission, exchangeId: string | undefined, limit: number) {
  if (!exchangeId) return;
  const exchange = state.mailbox.find(record => record.id === exchangeId && record.agentId === mission.agentId &&
    record.missionId === mission.id && record.missionRevision === mission.revision);
  if (exchange?.status !== "answered" || !exchange.usage || !exchange.outcome || exchange.output === null) return;

  return markInvocationContextMessage({role: "system", content: JSON.stringify({
    kind: "agent_delegation_result_v1", authority: "settled_exchange_with_untrusted_content",
    addsUserIntent: false, grantsPermissions: false,
    missionId: mission.id, missionRevision: mission.revision, exchangeId: exchange.id,
    recipientAgentId: exchange.recipientAgentId, outcome: exchange.outcome,
    assignment: exchange.assignment.slice(0, limit), omittedAssignmentCharacters: Math.max(0, exchange.assignment.length - limit),
    text: exchange.output.slice(0, limit), omittedReplyCharacters: Math.max(0, exchange.output.length - limit),
  })});
}
