import type {
  RoleCallFrame,
  RoleCallPolicy,
  RoleCallState,
} from "./contracts.js";
import type { ModelWorkPlanDefinition } from "./work-plan-contracts.js";
import { exactKeys, isRecord } from "../../validation/strict-record.js";
import { EXECUTION_AGENT_PLANNER_GRAPH_LIMITS } from "../../steps/planner-graph/contracts.js";
import { parsePlannerGraphOutput } from "../../steps/planner-graph/parser.js";

export function ownsModelWorkPlanSource(
  state: RoleCallState,
  call: RoleCallFrame,
  sourceResultRef: string,
): boolean {
  const source = state.results.find(
    (result) => result.resultRef === sourceResultRef,
  );
  if (!source || source.outcome !== "completed") return false;
  const producer = state.calls.find(
    (candidate) => candidate.callId === source.producerCallId,
  );
  if (!producer || producer.status !== "completed") return false;
  if (producer.parentCallId !== call.callId) return false;
  if (producer.resultRef !== source.resultRef) return false;
  return call.childCallIds.includes(producer.callId);
}

/** Derive the exact adoptable definition from the sole canonical result ledger. */
export function resolveModelWorkPlanSourceDefinition(
  state: RoleCallState,
  call: RoleCallFrame,
  sourceResultRef: string,
  policy: RoleCallPolicy,
): ModelWorkPlanDefinition | undefined {
  if (policy.authority.modelWorkPlanAuthority !== "root") return undefined;
  if (state.rootCallId !== call.callId || call.parentCallId !== null)
    return undefined;
  if (!ownsModelWorkPlanSource(state, call, sourceResultRef)) return undefined;
  const result = state.results.find(
    (entry) => entry.resultRef === sourceResultRef,
  )!;
  if (result.roleId !== "planner") return undefined;
  let advisory: unknown;
  try {
    advisory = JSON.parse(result.summary);
  } catch {
    return undefined;
  }
  if (!isOwnedPlannerProposalAdvisory(advisory, result.producerCallId))
    return undefined;
  const parsed = parsePlannerGraphOutput(
    JSON.stringify({ decision: advisory.proposal }),
    EXECUTION_AGENT_PLANNER_GRAPH_LIMITS,
  );
  if (!parsed.ok || parsed.decision.outcome !== "proposal") return undefined;
  return {
    summary: parsed.decision.proposal.summary,
    items: parsed.decision.proposal.nodes.map((node) => ({
      itemId: node.localId,
      title: node.title,
      objective: node.objective,
    })),
  };
}

function isOwnedPlannerProposalAdvisory(
  advisory: unknown,
  producerCallId: string,
): advisory is Record<string, unknown> {
  if (!isRecord(advisory)) return false;
  if (
    !exactKeys(advisory, [
      "kind",
      "authority",
      "presenceEffect",
      "plannerCallId",
      "outcome",
      "proposal",
    ])
  )
    return false;
  if (advisory.kind !== "runtime_execution_agent_planner_advisory_v1")
    return false;
  if (advisory.authority !== "model_advisory") return false;
  if (advisory.presenceEffect !== "passive_result_not_execution_or_completion")
    return false;
  if (advisory.plannerCallId !== producerCallId) return false;
  return advisory.outcome === "proposal";
}

/** Object key order is irrelevant; proposed item order and all semantic fields are exact. */
export function areModelWorkPlanDefinitionsEqual(
  definition: ModelWorkPlanDefinition,
  source: ModelWorkPlanDefinition,
): boolean {
  if (definition.summary !== source.summary) return false;
  if (definition.items.length !== source.items.length) return false;
  return definition.items.every((item, index) =>
    isSameModelWorkPlanItemDefinition(item, source.items[index]!),
  );
}

function isSameModelWorkPlanItemDefinition(
  item: ModelWorkPlanDefinition["items"][number],
  source: ModelWorkPlanDefinition["items"][number],
): boolean {
  if (item.itemId !== source.itemId) return false;
  if (item.title !== source.title) return false;
  return item.objective === source.objective;
}
