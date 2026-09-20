import type { ModelWorkPlanDefinition } from "../../orchestration/role-calls/work-plan-contracts.js";

export function createModelWorkPlanGraph(definition: ModelWorkPlanDefinition) {
  return {
    summary: definition.summary,
    nodes: definition.items.map((item) => ({
      localId: item.itemId,
      title: item.title,
      objective: item.objective,
      dependsOn: [],
      acceptanceCriteria: [
        {
          localId: `${item.itemId}-proof`,
          description: `Confirm ${item.title}.`,
          verification: "mechanical",
        },
      ],
    })),
  };
}

export function createModelWorkPlanAdvisorySummary(
  plannerCallId: string,
  definition: ModelWorkPlanDefinition,
): string {
  return JSON.stringify({
    kind: "runtime_execution_agent_planner_advisory_v1",
    authority: "model_advisory",
    presenceEffect: "passive_result_not_execution_or_completion",
    plannerCallId,
    outcome: "proposal",
    proposal: createModelWorkPlanGraph(definition),
  });
}
