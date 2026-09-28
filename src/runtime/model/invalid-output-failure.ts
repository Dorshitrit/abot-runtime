import type { ModelStep } from "../../shared/model-steps.js";
import { RawModelValidationError } from "./invoke-raw-step.js";
import { StructuredModelInvalidOutputError } from "./invoke-structured-step.js";

export type ModelOutputFailure = Readonly<{
  code: string;
  modelStep: ModelStep;
  validationStage: string;
  issues: readonly Readonly<{ code: string; path: string }>[];
  repairAttempts?: number;
}>;

const STRUCTURED_OUTPUT_FAILURE_STEPS: ReadonlyMap<
  string,
  readonly ModelStep[]
> = new Map([
  ["invalid_supervisor_decision", ["supervisor.decision"]],
  ["invalid_execution_agent_decision", ["execution.decision"]],
  ["invalid_planner_decision", ["planner.decision"]],
  ["invalid_worker_decision", ["worker.decision", "capability.controls"]],
  ["invalid_reviewer_decision", ["reviewer.decision"]],
  ["invalid_execution_agent_authored_response", ["execution.response"]],
  ["invalid_context_compaction_output", ["context.compact"]],
  ["invalid_session_memory_compaction_output", ["context.compact"]],
]);

const RAW_OUTPUT_FAILURE_CONTRACTS: ReadonlyMap<
  string,
  Readonly<{ modelStep: ModelStep; validationStage: string }>
> = new Map([
  [
    "invalid_worker_result",
    { modelStep: "worker.result", validationStage: "raw_result" },
  ],
  [
    "invalid_supervisor_response",
    { modelStep: "supervisor.response", validationStage: "raw_response" },
  ],
  [
    "invalid_execution_agent_response",
    { modelStep: "execution.response", validationStage: "response_contract" },
  ],
]);

const COMPACTION_OUTPUT_ISSUE_CODES: ReadonlySet<string> = new Set([
  "context_compaction_output_not_json",
  "context_compaction_output_shape_invalid",
  "context_compaction_continuation_invalid",
  "context_compaction_continuation_length_invalid",
  "context_compaction_sources_invalid",
  "context_compaction_source_invalid",
  "context_compaction_digest_length_invalid",
  "context_compaction_digest_not_semantic",
]);

const SESSION_MEMORY_OUTPUT_ISSUE_CODES: ReadonlySet<string> = new Set([
  "session_memory_output_not_json",
  "session_memory_output_shape_invalid",
  "session_memory_summary_invalid",
]);

/** Recognizes only exhausted model-output contracts, never runtime error text. */
export function resolveModelOutputFailure(
  error: unknown,
): ModelOutputFailure | undefined {
  if (error instanceof StructuredModelInvalidOutputError) {
    return resolveStructuredOutputFailure(error);
  }
  if (!(error instanceof RawModelValidationError)) return undefined;
  const contract = RAW_OUTPUT_FAILURE_CONTRACTS.get(error.reason);
  if (!contract) return undefined;
  if (error.stage !== contract.validationStage) return undefined;
  return Object.freeze({
    code: error.reason,
    ...contract,
    issues: projectOutputValidationIssues(error.issues),
  });
}

function resolveStructuredOutputFailure(
  error: StructuredModelInvalidOutputError,
): ModelOutputFailure | undefined {
  const allowedSteps = STRUCTURED_OUTPUT_FAILURE_STEPS.get(error.message);
  if (!allowedSteps) return undefined;
  if (!allowedSteps.includes(error.modelStep)) return undefined;
  if (!hasModelOwnedCompactionIssues(error)) return undefined;
  return Object.freeze({
    code: error.message,
    modelStep: error.modelStep,
    validationStage: error.validationStage.slice(0, 120),
    issues: projectOutputValidationIssues(error.issues),
    repairAttempts: error.repairAttempts,
  });
}

function hasModelOwnedCompactionIssues(
  error: StructuredModelInvalidOutputError,
): boolean {
  if (error.message === "invalid_context_compaction_output") {
    // Source identity and allowance invariants are checked before inference.
    // Only model-output issues may cross the role boundary as failed work.
    return hasOnlyKnownOutputIssues(
      error.issues,
      COMPACTION_OUTPUT_ISSUE_CODES,
    );
  }
  if (error.message === "invalid_session_memory_compaction_output") {
    return hasOnlyKnownOutputIssues(
      error.issues,
      SESSION_MEMORY_OUTPUT_ISSUE_CODES,
    );
  }
  return true;
}

function hasOnlyKnownOutputIssues(
  issues: readonly Readonly<{ code: string }>[],
  allowedCodes: ReadonlySet<string>,
): boolean {
  if (issues.length === 0) return false;
  return issues.every(({ code }) => allowedCodes.has(code));
}

function projectOutputValidationIssues(
  issues: readonly Readonly<{ code: string; path: string }>[],
): ModelOutputFailure["issues"] {
  return Object.freeze(
    issues
      .slice(0, 8)
      .map(({ code, path }) =>
        Object.freeze({ code: code.slice(0, 120), path: path.slice(0, 160) }),
      ),
  );
}
