import type { CapabilityControlsPartition } from "../../orchestration/capability-adapters/index.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type { ExecutionAgentDecisionValidationIssue } from "./contracts.js";

/** The actual EA partition owns this requirement; payload authority alone does not. */
export function requiresControlsEvidenceSelection(
  partition: Pick<CapabilityControlsPartition, "remainingSchema">,
): boolean {
  return Object.keys(partition.remainingSchema.properties).length > 0;
}

export function projectEligibleControlsEvidenceExecutionIds(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): readonly string[] {
  return freezeControlsEvidenceEligibility(
    head.state.capabilityExecutions
      .filter(
        (execution) =>
          execution.callId === call.callId && execution.status === "settled",
      )
      .map((execution) => execution.executionId),
  );
}

export function freezeControlsEvidenceEligibility(
  value: readonly string[] = [],
): readonly string[] {
  if (!isControlsEvidenceIdList(value))
    throw new Error("execution_agent_controls_evidence_eligibility_invalid");
  if (new Set(value).size !== value.length)
    throw new Error("execution_agent_controls_evidence_eligibility_invalid");
  return Object.freeze([...value]);
}

export function controlsEvidenceSelectionSchema(
  eligible: readonly string[],
): Record<string, unknown> {
  const maximumIdLength = eligible.reduce(
    (maximum, id) => Math.max(maximum, id.length),
    0,
  );
  return {
    type: "array",
    minItems: 0,
    maxItems: eligible.length,
    items: {
      type: "string",
      minLength: 1,
      ...(maximumIdLength > 0 ? { maxLength: maximumIdLength } : {}),
    },
    description:
      "Select eligible settled execution IDs needed to construct the complete operation, including source format, field meanings, representative data, prior outcomes or exact targets. Controls receives only selected evidence, as verified summaries where available or original results otherwise. Use [] only when the frozen operation and fixed sources supply the needed information; knowing a path alone does not establish its contents or format.",
  };
}

export function parseControlsEvidenceSelection(
  params: Readonly<{
    value: unknown;
    required: boolean;
    eligible: readonly string[];
    path: string;
    issues: ExecutionAgentDecisionValidationIssue[];
  }>,
): Readonly<{ ok: true; value?: readonly string[] }> | Readonly<{ ok: false }> {
  if (!params.required) return Object.freeze({ ok: true });
  const rejection = controlsEvidenceSelectionRejection(
    params.value,
    params.eligible,
  );
  if (rejection) {
    params.issues.push({
      code: "execution_agent_controls_evidence_invalid",
      path: params.path,
      message: rejection,
    });
    return Object.freeze({ ok: false });
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze([...(params.value as readonly string[])]),
  });
}

export function controlsEvidenceSelectionRejection(
  value: unknown,
  eligible: readonly string[],
): string | undefined {
  if (!isControlsEvidenceIdList(value))
    return "controlsEvidenceExecutionIds must be an explicit array of nonempty canonical execution IDs.";
  if (value.length > eligible.length)
    return "Evidence selection exceeds the eligible settled execution count.";
  if (new Set(value).size !== value.length)
    return "Evidence selection must not repeat an execution ID.";
  const eligibleIds = new Set(eligible);
  if (value.some((id) => !eligibleIds.has(id)))
    return "Every selected execution ID must be eligible in this exact request, call and decision head.";
  return undefined;
}

function isControlsEvidenceIdList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  return value.every((id) => typeof id === "string" && id.length > 0);
}
