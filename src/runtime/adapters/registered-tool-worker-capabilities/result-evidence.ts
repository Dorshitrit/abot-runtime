import type { ToolActionSummary } from "../../../capabilities/tool-types.js";
import {
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCapabilityResultReference,
} from "../../orchestration/role-calls/index.js";
import {
  normalizeCapabilityAdapterResult,
  type CapabilityAdapterResult,
} from "../../orchestration/capability-adapters/index.js";
import type { WorkerCapabilityAdapterResult } from "../../orchestration/worker-capabilities/index.js";
import type { RegisteredToolNormalInvocationResult } from "../registered-tool-normal-invocations.js";
import { projectTargetReferences } from "./result-references.js";
export {
  projectSelectedTargetReferences,
  projectToolTargetReferences,
} from "./result-references.js";
import { projectRegisteredToolResultEnvelope } from "./result-envelope.js";
import { executionProtocolError } from "./errors.js";
import { isPlainRecord, nonEmpty } from "./values.js";

const MUTATION_GROUNDING_MAX_LENGTH = 32_768;
const OBSERVATION_OUTPUT_PREVIEW_MAX_LENGTH = 512;

export function summarizeCompletedMutation(
  completionActions: readonly ToolActionSummary[],
): string {
  if (completionActions.length === 0) {
    return boundedSummary(
      "The mutation capability reported a completed change.",
    );
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
  selectedReferences: readonly RoleCapabilityResultReference[] = [],
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
  return requireCapabilityAdapterResult(
    projectRegisteredToolResultEnvelope(
      input.result,
      input.completionActions,
      selectedReferences,
    ),
  );
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
  if (directRoot) {
    return Object.freeze({
      summary:
        "The capability result is available in the canonical direct execution result.",
    });
  }
  const preview = normalized
    .slice(0, OBSERVATION_OUTPUT_PREVIEW_MAX_LENGTH)
    .replace(/[\uD800-\uDBFF]$/u, "");
  const omittedCharacters = normalized.length - preview.length;
  const hasBoundedReferenceData =
    normalized.length <= ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH;
  return Object.freeze({
    summary: `The observation returned ${normalized.length} characters of result data. Output preview (${preview.length} characters; ${omittedCharacters} omitted from this preview):\n${preview}`,
    ...(hasBoundedReferenceData ? { referenceData: normalized } : {}),
  });
}
