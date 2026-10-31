import type { RoleExecutionResult } from "../contracts.js";

const runtimeSteeringYields = new WeakSet<object>();

/** A runtime control receipt, never a model-authored work outcome. */
export function createRoleSteeringYield(
  steeringVersion: number,
  maxSummaryLength: number,
): RoleExecutionResult<never> {
  const result = Object.freeze({
    kind: "terminal" as const,
    outcome: "yielded" as const,
    steeringVersion,
    summary: "The Worker yielded to its caller because newer user steering requires a decision.".slice(0, maxSummaryLength),
  });
  runtimeSteeringYields.add(result);
  return result;
}

export function isRuntimeRoleSteeringYield(
  result: object,
): boolean {
  return runtimeSteeringYields.has(result);
}
