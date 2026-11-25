import type { AgentDefinition, AgentMissionLimits } from "../../agents/agent-records.js";
import type { AgentStateCommand } from "../../agents/state-commands.js";
import type { FileAgentStateStore } from "../../agents/file-store.js";

export const AGENT_FOUNDATION_TIME = "2026-11-17T10:00:00.000Z";

export function agentDefinition(name = "Research") {
  return {
    name,
    icon: "pebbles-blue",
    basePrompt: "Find evidence for the assigned objective.",
    modelProfileId: "fixture-super",
    executionPolicy: "supervisor-worker-v1" as const,
    toolPermissionMode: "ask" as const,
  } satisfies AgentDefinition;
}

export function agentMissionLimits(): AgentMissionLimits {
  return {
    maxAttempts: 4,
    maxModelCalls: 24,
    maxTotalTokens: 20_000,
    maxConsecutiveNoProgress: 2,
    maxClarificationRounds: 3,
  };
}

export function startAgentMission(agentId = "agent-a", missionId = "mission-a"): Extract<AgentStateCommand, { kind: "start_mission" }> {
  return {
    kind: "start_mission", agentId, missionId,
    objective: "Compare the supplied fictional monitor specifications.",
    successCriteria: [{ id: "sources", description: "Every comparison cites a supplied source." }],
    limits: agentMissionLimits(),
  };
}

export async function commitAgentCommand(store: FileAgentStateStore, command: AgentStateCommand) {
  return store.commit(command, (await store.read()).revision);
}
