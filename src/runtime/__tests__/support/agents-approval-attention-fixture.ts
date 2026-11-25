import { createEmptyAgentState, type AgentState } from "../../agents/agent-records.js";
import { reduceAgentCommand } from "../../agents/state-reducer.js";
import type { AgentStateCommand } from "../../agents/state-commands.js";
import type { SessionRequestLifecycleSnapshot } from "../../../sessions/request-lifecycle/contracts.js";
import { agentDefinition, agentMissionLimits } from "./agents-foundation-fixture.js";

/** Projection fixtures intentionally omit unrelated work execution fields. */
export function delegatedApprovalFixture(started = Date.now()) {
  let state = createEmptyAgentState(), time = started;
  const commit = (command: AgentStateCommand) => {
    state = reduceAgentCommand(state, command, new Date(++time).toISOString());
  };
  for (const id of ["parent", "child", "grandchild", "other"]) {
    commit({ kind: "register_agent", agentId: id, definition: agentDefinition(id) });
    commit({ kind: "open_agent_turn", agentId: id, missionId: `mission-${id}`, messageId: `origin-${id}`,
      text: "A bounded task", intent: "task", limits: agentMissionLimits(), source: null });
  }
  const exchanges = [["parent", "child"], ["child", "grandchild"]].map(([from, to]) => ({
    id: `exchange-${to}`, agentId: from, missionId: `mission-${from}`, recipientAgentId: to, status: "pending",
  })) as unknown as AgentState["mailbox"];
  state = { ...state, mailbox: exchanges, messages: state.messages.map(message => {
    const exchange = exchanges.find(item => item.recipientAgentId === message.agentId);
    return exchange ? { ...message, role: "abot", source: { agentId: exchange.agentId,
      missionId: exchange.missionId, correlationId: exchange.id } } : message;
  }), attempts: ["child", "grandchild", "other"].map(id => ({ id: `attempt-${id}`, agentId: id,
    missionId: `mission-${id}`, status: "awaiting_approval", userResolved: false,
    request: { sessionId: `session-${id}`, requestId: `request-${id}` },
  })) as unknown as AgentState["attempts"] };
  function wait(id = "child", waitId = "wait-1") {
    return { schemaVersion: 1, sessionId: `session-${id}`, requestId: `request-${id}`, generation: "generation",
      status: "awaiting_approval", revision: 4, wait: { waitId, createdAt: new Date(started + 20).toISOString() },
      decisionReceipts: [] } as unknown as SessionRequestLifecycleSnapshot;
  }
  return { state, wait, started };
}
