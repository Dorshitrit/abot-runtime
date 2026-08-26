import { MODEL_STEPS } from "../../../shared/model-steps.js";

export const PLANNER_GRAPH_MODEL_STEP = MODEL_STEPS.PLANNER_GRAPH;
export const PLANNER_GRAPH_NODE_LIMIT_MAX = 16;
export const PLANNER_GRAPH_CRITERIA_LIMIT_MAX = 8;
export const PLANNER_GRAPH_IDENTIFIER_MAX_LENGTH = 128;
export const PLANNER_GRAPH_TEXT_MAX_LENGTH = 8_192;
export const PLANNER_GRAPH_VALIDATION_ISSUE_COUNT_MAX = 32;

export type PlannerGraphLimits = Readonly<{
  maxPlanNodes: number;
  maxCriteriaPerNode: number;
}>;

export const EXECUTION_AGENT_PLANNER_GRAPH_LIMITS = Object.freeze({
  maxPlanNodes: PLANNER_GRAPH_NODE_LIMIT_MAX,
  maxCriteriaPerNode: PLANNER_GRAPH_CRITERIA_LIMIT_MAX,
});

export function sealPlannerGraphLimits(
  input: PlannerGraphLimits,
): PlannerGraphLimits {
  if (
    !Number.isSafeInteger(input?.maxPlanNodes) ||
    input.maxPlanNodes < 2 ||
    input.maxPlanNodes > PLANNER_GRAPH_NODE_LIMIT_MAX ||
    !Number.isSafeInteger(input?.maxCriteriaPerNode) ||
    input.maxCriteriaPerNode < 1 ||
    input.maxCriteriaPerNode > PLANNER_GRAPH_CRITERIA_LIMIT_MAX
  ) {
    throw new Error("planner_graph_limits_invalid");
  }
  return Object.freeze({
    maxPlanNodes: input.maxPlanNodes,
    maxCriteriaPerNode: input.maxCriteriaPerNode,
  });
}

export type PlannerAcceptanceCriterionProposal = Readonly<{
  localId: string;
  description: string;
  verification: "mechanical" | "semantic";
}>;

export type PlannerGraphNodeProposal = Readonly<{
  localId: string;
  title: string;
  objective: string;
  dependsOn: readonly string[];
  acceptanceCriteria: readonly PlannerAcceptanceCriterionProposal[];
}>;

export type PlannerGraphProposal = Readonly<{
  summary: string;
  nodes: readonly PlannerGraphNodeProposal[];
}>;

export type PlannerGraphOutcome =
  | Readonly<{ outcome: "proposal"; proposal: PlannerGraphProposal }>
  | Readonly<{ outcome: "decline"; reason: string }>;

export type PlannerGraphValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type PlannerGraphParseResult =
  | Readonly<{ ok: true; decision: PlannerGraphOutcome }>
  | Readonly<{
      ok: false;
      stage: "json_envelope" | "domain_parser";
      issues: readonly PlannerGraphValidationIssue[];
    }>;
