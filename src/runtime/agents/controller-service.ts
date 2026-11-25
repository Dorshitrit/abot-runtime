import type { AgentState } from "./agent-records.js";
import type { AgentControllerCommand } from "./controller-commands.js";
import { captureAgentDecisionConfiguration } from "./decision-configuration.js";
import type { FileAgentStateStore } from "./file-store.js";
import type { AgentInvocationUsage } from "./invocation-records.js";
import type { AgentModelConfiguration } from "./model-binding.js";
import { AgentStateError } from "./state-error.js";

type ReserveInput = Omit<Extract<AgentControllerCommand, { kind: "reserve_invocation" }>, "kind" | "configuration">;

/** Trusted runtime API: none of these operations calls a model, a tool or the looper. */
export type AgentControllerService = Readonly<{
  read: () => Promise<AgentState>;
  reserve: (input: ReserveInput, expectedRevision: number) => Promise<AgentState>;
  settle: (agentId: string, invocationId: string, usage: AgentInvocationUsage | null, expectedRevision: number) => Promise<AgentState>;
  decide: (agentId: string, invocationId: string, decisionId: string, proposalJson: string, expectedRevision: number) => Promise<AgentState>;
  reconcile: () => Promise<AgentState>;
}>;

export function createAgentControllerService(
  store: Pick<FileAgentStateStore, "read" | "commit" | "reconcile">,
  config: AgentModelConfiguration,
): AgentControllerService {
  const captured = structuredClone({ models: config.models, modelExecutionPolicies: config.modelExecutionPolicies });
  async function configurationFor(agentId: string) {
    const state = await store.read();
    const agent = state.agents.find((entry) => entry.id === agentId);
    if (!agent) throw new AgentStateError("agents_agent_not_found");
    return captureAgentDecisionConfiguration(agent.definition, captured);
  }
  return Object.freeze({
    read: () => store.read(),
    async reserve(input, expectedRevision) {
      // Capture before the asynchronous read; callers cannot swap the target in flight.
      const reservation = structuredClone(input);
      const configuration = await configurationFor(reservation.agentId);
      if (!configuration) throw new AgentStateError("agents_model_configuration_unavailable");
      return store.commit({ ...reservation, kind: "reserve_invocation", configuration }, expectedRevision);
    },
    settle: (agentId, invocationId, usage, expectedRevision) =>
      store.commit({ kind: "settle_invocation", agentId, invocationId, usage }, expectedRevision),
    async decide(agentId, invocationId, decisionId, proposalJson, expectedRevision) {
      const currentConfiguration = await configurationFor(agentId);
      return store.commit({ kind: "record_decision", agentId, invocationId, decisionId, proposalJson, currentConfiguration }, expectedRevision);
    },
    reconcile: () => store.reconcile(),
  } satisfies AgentControllerService);
}
