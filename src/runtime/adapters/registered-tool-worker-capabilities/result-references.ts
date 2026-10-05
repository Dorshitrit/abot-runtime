import type { ToolActionSummary } from "../../../capabilities/tool-types.js";
import {
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  type RoleCapabilityResultReference,
} from "../../orchestration/role-calls/index.js";
import type { RegisteredToolNormalInvocationProjection } from "../registered-tool-normal-invocations.js";

export function projectToolTargetReferences(
  completionActions: readonly ToolActionSummary[],
) {
  return projectTargetReferences(completionActions.map(({ target }) => target));
}

export function projectSelectedTargetReferences(
  projection: RegisteredToolNormalInvocationProjection,
  controls: Readonly<Record<string, unknown>>,
  directRootSelectionControlIds?: readonly string[],
): readonly RoleCapabilityResultReference[] {
  const targetParam =
    projection.stagedPayloadPlan?.targetParam ??
    projection.payloadContextPlan?.targetParam;
  const targetParams = targetParam
    ? [targetParam]
    : (directRootSelectionControlIds ?? []);
  return projectTargetReferences(targetParams.map((param) => controls[param]));
}

export function projectTargetReferences(
  values: readonly unknown[],
): readonly RoleCapabilityResultReference[] {
  const targets = new Set<string>();
  const references: RoleCapabilityResultReference[] = [];
  for (const value of values) {
    const target = typeof value === "string" ? value.trim() : "";
    if (
      !target ||
      target.length > ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH ||
      targets.has(target)
    ) {
      continue;
    }
    targets.add(target);
    references.push(Object.freeze({ kind: "tool_target", target }));
    if (references.length >= ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX) break;
  }
  return Object.freeze(references);
}
