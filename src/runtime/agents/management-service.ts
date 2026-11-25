import { materializeAgentAuthoring, previewAgentAuthoring, readAgentAuthoring } from "./authoring.js";
import { randomUUID } from "node:crypto";
import type { AgentState } from "./agent-records.js";
import type { FileAgentStateStore } from "./file-store.js";
import type { AgentCatalog, AgentManagementService } from "./management-contracts.js";
import { createAgentModelBinding, type AgentModelConfiguration } from "./model-binding.js";

type AgentManagementStore = Pick<FileAgentStateStore, "read" | "commit" | "reconcile">;

/** The store remains the single writer. Revision conflicts and unknown writes are never retried. */
export function createAgentManagementService(
  store: AgentManagementStore,
  config: AgentModelConfiguration,
): AgentManagementService {
  const modelBinding = createAgentModelBinding(config);
  function projectCatalog(state: AgentState): AgentCatalog {
    return {
      revision: state.revision,
      agents: state.agents.map((agent) => ({ ...agent, modelBinding: modelBinding.inspect(agent.definition) })),
    };
  }
  async function currentAgent(id: string) {
    const agent = (await store.read()).agents.find(candidate => candidate.id === id);
    if (!agent) throw new Error("agents_agent_not_found");
    return agent;
  }
  return Object.freeze({
    async read() {
      return projectCatalog(await store.read());
    },
    async previewAuthoring(authoring, targetAgentId) {
      const draft = readAgentAuthoring(authoring, true);
      return previewAgentAuthoring(draft, modelBinding.resolvePolicy, targetAgentId ? await currentAgent(targetAgentId) : undefined);
    },
    async register(input, expectedRevision) {
      const definition = "authoring" in input ? materializeAgentAuthoring(input.authoring, modelBinding.resolvePolicy) : input;
      const command = { kind: "register_agent" as const, agentId: randomUUID(), definition: modelBinding.define(definition) };
      return projectCatalog(await store.commit(command, expectedRevision));
    },
    async update(agentId, input, expectedRevision) {
      const definition = "authoring" in input ? materializeAgentAuthoring(input.authoring, modelBinding.resolvePolicy, await currentAgent(agentId)) : input;
      const command = { kind: "update_definition" as const, agentId, definition: modelBinding.define(definition) };
      return projectCatalog(await store.commit(command, expectedRevision));
    },
    async archive(agentId, expectedRevision) {
      return projectCatalog(await store.commit({ kind: "archive_agent", agentId }, expectedRevision));
    },
    async restore(agentId, expectedRevision) {
      return projectCatalog(await store.commit({ kind: "restore_agent", agentId }, expectedRevision));
    },
    async reconcile() {
      return projectCatalog(await store.reconcile());
    },
  } satisfies AgentManagementService);
}
