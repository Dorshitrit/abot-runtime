import type { ToolActionSummary } from "../../../capabilities/tool-types.js";
import {
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCapabilityResultReference,
} from "../../orchestration/role-calls/index.js";
import {
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResult,
} from "../../orchestration/capability-adapters/index.js";
import type { WorkerCapabilityAdapterResult } from "../../orchestration/worker-capabilities/index.js";
import type {
  RegisteredToolNormalInvocationProjection,
  RegisteredToolNormalInvocationResult,
} from "../registered-tool-normal-invocations.js";
import { executionProtocolError } from "./errors.js";
import { isPlainRecord, nonEmpty } from "./values.js";

const MUTATION_GROUNDING_MAX_LENGTH = 32_768;

export function summarizeCompletedMutation(
  completionActions: readonly ToolActionSummary[],
): string {
  if (completionActions.length === 0) {
    return boundedSummary("The mutation capability reported a completed change.");
  }
  return boundedSummary(
    [
      "The mutation capability completed these logical effects:",
      ...completionActions.map((action) =>
        action.target
          ? `- ${action.type}: ${action.target}`
          : `- ${action.type}`,
      ),
    ].join("\n"),
  );
}

export function projectMutationGrounding(
  input: unknown,
  directRoot = false,
): string | undefined {
  const normalized = nonEmpty(input);
  if (!normalized) return undefined;
  if (directRoot && normalized.length > MUTATION_GROUNDING_MAX_LENGTH) {
    return undefined;
  }
  return normalized.length <= MUTATION_GROUNDING_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, MUTATION_GROUNDING_MAX_LENGTH - 1)}…`;
}

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

export function attachTargetReferences(
  result: WorkerCapabilityAdapterResult,
  selected: readonly RoleCapabilityResultReference[],
): WorkerCapabilityAdapterResult {
  if (selected.length === 0) return result;
  const references = projectTargetReferences([
    ...selected.map(({ target }) => target),
    ...(result.references ?? []).map(({ target }) => target),
  ]);
  return Object.freeze({
    ...result,
    references,
    ...(result.exactResult
      ? {
          exactResult: requireCapabilityAdapterResult({
            ...result.exactResult,
            references: projectTargetReferences([
              ...selected.map(({ target }) => target),
              ...(result.exactResult.references ?? []).map(
                ({ target }) => target,
              ),
            ]),
          }),
        }
      : {}),
  });
}

export function captureRegisteredToolResult(
  input: RegisteredToolNormalInvocationResult,
): CapabilityAdapterResult {
  if (input.status === "rejected") {
    return requireCapabilityAdapterResult({
      kind: "runtime_capability_rejection_v1",
      authority: "runtime",
      status: "rejected",
      stage: "before_external_execution",
      code: input.code,
      message: input.message,
    });
  }
  const references = projectToolTargetReferences(input.completionActions);
  return requireCapabilityAdapterResult({
    kind: "registered_tool_execution_result_v1",
    authority: "registered_plugin",
    status: "executed",
    result: input.result,
    ...(references.length > 0 ? { references } : {}),
  });
}

export function requireCapabilityAdapterResult(
  input: unknown,
): CapabilityAdapterResult {
  const normalized = normalizeCapabilityAdapterResult(input);
  if (!normalized.ok) {
    throw executionProtocolError(`canonical_result_${normalized.code}`);
  }
  return normalized.value;
}

function projectTargetReferences(
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

export function validateToolExecutionResult(input: unknown): void {
  if (
    !isPlainRecord(input) ||
    typeof input.ok !== "boolean" ||
    !nonEmpty(input.tool) ||
    typeof input.output !== "string" ||
    typeof input.producedNewInformation !== "boolean" ||
    (input.data !== undefined && !isPlainRecord(input.data)) ||
    (isPlainRecord(input.data) &&
      input.data.currentStateEvidence !== undefined &&
      typeof input.data.currentStateEvidence !== "boolean") ||
    (isPlainRecord(input.data) &&
      input.data.mutationEvidence !== undefined &&
      typeof input.data.mutationEvidence !== "boolean") ||
    (isPlainRecord(input.data) &&
      input.data.stateAlreadySatisfied !== undefined &&
      typeof input.data.stateAlreadySatisfied !== "boolean")
  ) {
    throw executionProtocolError("tool_result_invalid");
  }
}

export function boundedSummary(input: string, directRoot = false): string {
  const normalized = input.trim();
  if (normalized.length > ROLE_CALL_RESULT_MAX_LENGTH) {
    return directRoot
      ? "The capability result is available in the canonical direct execution result."
      : "The capability result is available in the canonical execution result.";
  }
  return normalized;
}

export function projectObservationOutput(
  input: string,
  directRoot = false,
): Readonly<{
  summary: string;
  referenceData?: string;
}> {
  const normalized = input.trim();
  if (normalized.length <= ROLE_CALL_RESULT_MAX_LENGTH) {
    return Object.freeze({ summary: normalized });
  }
  if (
    directRoot ||
    normalized.length > ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH
  ) {
    return Object.freeze({
      summary: directRoot
        ? "The capability result is available in the canonical direct execution result."
        : "The capability result is available in the canonical execution result.",
    });
  }
  return Object.freeze({
    summary: `The observation completed successfully with ${normalized.length} characters of result data; its producing Worker received the complete result.`,
    referenceData: normalized,
  });
}
