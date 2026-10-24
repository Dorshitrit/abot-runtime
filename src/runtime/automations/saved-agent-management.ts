import { randomUUID } from "node:crypto";
import type { AgentNode, WorkflowNode } from "./definition-contracts.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationSavedAgentRecord } from "./storage-records.js";

function findAgent(node: WorkflowNode, nodeId: string): AgentNode | undefined {
  if (node.id === nodeId) return node.kind === "agent" ? node : undefined;
  if (node.kind === "sequence") {
    for (const child of node.children) {
      const found = findAgent(child, nodeId);
      if (found) return found;
    }
  }
  if (node.kind === "parallel") {
    for (const branch of node.branches) {
      const found = findAgent(branch, nodeId);
      if (found) return found;
    }
  }
  return undefined;
}

/** A reusable step template. Runtime inputs, prior grants and execution state never enter it. */
function snapshotAgent(agent: AgentNode, id: string): AgentNode {
  return structuredClone({
    kind: "agent",
    id,
    title: agent.title,
    onFailure: agent.onFailure,
    modelProfileId: agent.modelProfileId,
    agentMode: agent.agentMode,
    ...(agent.reasoningPreference ? { reasoningPreference: agent.reasoningPreference } : {}),
    roleInstructions: agent.roleInstructions,
    prompt: agent.prompt,
    inputs: {},
    tools: agent.tools,
    result: agent.result,
    ...(agent.acceptance ? { acceptance: agent.acceptance } : {}),
  });
}

export function createAutomationSavedAgentManager(options: {
  persistence: AutomationPersistence;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  async function get(agentId: string, revision?: number): Promise<AutomationSavedAgentRecord | null> {
    const state = await options.persistence.read();
    return state.savedAgents
      .filter((record) => record.agentId === agentId &&
        (revision === undefined || record.revision === revision))
      .sort((left, right) => right.revision - left.revision)[0] ?? null;
  }

  async function list(): Promise<AutomationSavedAgentRecord[]> {
    const state = await options.persistence.read();
    const latest = new Map<string, AutomationSavedAgentRecord>();
    for (const record of state.savedAgents) {
      const previous = latest.get(record.agentId);
      if (!previous || record.revision > previous.revision) latest.set(record.agentId, record);
    }
    return [...latest.values()].sort((left, right) => left.agent.title.localeCompare(right.agent.title));
  }

  async function saveFromDraft(input: {
    automationId: string;
    nodeId: string;
    expectedDraftRevision: number;
    agentId?: string;
    expectedAgentRevision?: number;
  }): Promise<AutomationSavedAgentRecord> {
    if (!Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 1)
      throw new Error("automation_revision_conflict");
    if (input.agentId && (!Number.isSafeInteger(input.expectedAgentRevision) ||
      Number(input.expectedAgentRevision) < 1))
      throw new Error("automation_revision_conflict");
    if (!input.agentId && input.expectedAgentRevision !== undefined)
      throw new Error("automation_revision_conflict");
    return options.persistence.update((state) => {
      const draft = state.drafts.find((record) => record.automationId === input.automationId);
      if (!draft) throw new Error("automation_not_found");
      if (draft.revision !== input.expectedDraftRevision)
        throw new Error("automation_revision_conflict");
      const agent = findAgent(draft.definition.body, input.nodeId);
      if (!agent) throw new Error("automation_dependency_missing");
      const prior = input.agentId
        ? state.savedAgents.filter((record) => record.agentId === input.agentId)
          .sort((left, right) => right.revision - left.revision)[0]
        : undefined;
      if (input.agentId && (!prior || prior.revision !== input.expectedAgentRevision))
        throw new Error("automation_revision_conflict");
      const agentId = input.agentId ?? randomUUID();
      const revision = (prior?.revision ?? 0) + 1;
      const saved: AutomationSavedAgentRecord = {
        id: `agent:${agentId}:${revision}`,
        agentId,
        revision,
        agent: snapshotAgent(agent, `n_${randomUUID().replaceAll("-", "")}`),
        updatedAt: new Date(now()).toISOString(),
      };
      state.savedAgents.push(saved);
      return saved;
    });
  }

  return { get, list, saveFromDraft };
}
