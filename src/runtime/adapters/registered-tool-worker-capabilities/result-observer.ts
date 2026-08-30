import type {
  ToolActionSummary,
  ToolExecutionResult,
} from "../../../capabilities/tool-types.js";
import type { WorkerCapabilityAdapterResult } from "../../orchestration/worker-capabilities/index.js";
import type { RegisteredToolNormalInvocationResult } from "../registered-tool-normal-invocations.js";
import { executionProtocolError } from "./errors.js";
import { createRegisteredToolWorkerFailureOutcomeFingerprint } from "./failure-outcome-fingerprint.js";
import {
  boundedSummary,
  captureRegisteredToolResult,
  projectMutationGrounding,
  projectObservationOutput,
  projectToolTargetReferences,
  summarizeCompletedMutation,
  validateToolExecutionResult,
} from "./result-evidence.js";
import { isPlainRecord, nonEmpty, safeIssueCode } from "./values.js";

type ProjectedWorkerCapabilityAdapterResult =
  | Extract<WorkerCapabilityAdapterResult, { outcome: "succeeded" }>
  | Omit<
      Extract<WorkerCapabilityAdapterResult, { outcome: "failed" }>,
      "failureOutcomeFingerprint"
    >;

type ProjectedExternalResult = Readonly<{
  result: ProjectedWorkerCapabilityAdapterResult;
  sourceIssueCode?: string;
}>;

type ObservedExternalResult = Readonly<{
  result: WorkerCapabilityAdapterResult;
  sourceIssueCode?: string;
}>;

export function observeExternalResult(
  input: RegisteredToolNormalInvocationResult,
  expectedEffect: "read_only" | "mutating" | "mixed",
  directRoot: boolean,
): ObservedExternalResult {
  const observed = observeExternalResultLegacy(
    input,
    expectedEffect,
    directRoot,
  );
  const exactResult = captureRegisteredToolResult(input);
  return Object.freeze({
    ...observed,
    result:
      observed.result.outcome === "failed"
        ? Object.freeze({
            ...observed.result,
            exactResult,
            failureOutcomeFingerprint:
              createRegisteredToolWorkerFailureOutcomeFingerprint(exactResult),
          })
        : Object.freeze({
            ...observed.result,
            exactResult,
          }),
  });
}

function observeExternalResultLegacy(
  input: RegisteredToolNormalInvocationResult,
  expectedEffect: "read_only" | "mutating" | "mixed",
  directRoot: boolean,
): ProjectedExternalResult {
  if (!isPlainRecord(input)) {
    throw executionProtocolError("result_not_object");
  }
  if (input.status === "rejected") {
    const sourceIssueCode = safeIssueCode(input.code);
    if (!sourceIssueCode || !nonEmpty(input.message)) {
      throw executionProtocolError("rejection_invalid");
    }
    return Object.freeze({
      result: Object.freeze({
        outcome: "failed",
        observedEffect: "none",
        summary: boundedSummary(input.message, directRoot),
      }),
      sourceIssueCode,
    });
  }
  if (input.status !== "executed" || input.effect !== expectedEffect) {
    throw executionProtocolError("effect_or_status_invalid");
  }
  const result = input.result as unknown;
  validateToolExecutionResult(result);
  const execution = result as ToolExecutionResult;
  if (expectedEffect === "mixed") {
    return observeMixedResult(execution, input.completionActions, directRoot);
  }
  if (expectedEffect === "mutating") {
    return observeMutationResult(
      execution,
      input.completionActions,
      directRoot,
    );
  }
  if (execution.ok) {
    const output = nonEmpty(execution.output);
    if (!output) {
      return Object.freeze({
        result: Object.freeze({
          outcome: "failed",
          observedEffect: "none",
          summary: "The observation capability returned no usable result.",
        }),
        sourceIssueCode: "observation_output_missing",
      });
    }
    const references = projectToolTargetReferences(input.completionActions);
    const observation = projectObservationOutput(output, directRoot);
    return Object.freeze({
      result: Object.freeze({
        outcome: "succeeded",
        observedEffect: "observation",
        ...observation,
        ...(references.length > 0 ? { references } : {}),
      }),
    });
  }
  return Object.freeze({
    result: Object.freeze({
      outcome: "failed",
      observedEffect:
        execution.data?.currentStateEvidence === true ? "observation" : "none",
      summary: boundedSummary(
        nonEmpty(execution.error) ??
          nonEmpty(execution.output) ??
          "The observation capability reported an execution failure.",
        directRoot,
      ),
    }),
    sourceIssueCode:
      safeIssueCode(execution.errorCode) ?? "tool_execution_failed",
  });
}

function observeMixedResult(
  execution: ToolExecutionResult,
  completionActions: readonly ToolActionSummary[],
  directRoot: boolean,
): ProjectedExternalResult {
  const output = nonEmpty(execution.output);
  if (execution.ok && execution.data?.mutationEvidence === true) {
    const references = projectToolTargetReferences(completionActions);
    const referenceData = projectMutationGrounding(
      execution.data?.mutationGrounding,
      directRoot,
    );
    return Object.freeze({
      result: Object.freeze({
        outcome: "succeeded",
        observedEffect: "mutation",
        summary: summarizeCompletedMutation(completionActions),
        ...(referenceData ? { referenceData } : {}),
        ...(references.length > 0 ? { references } : {}),
      }),
    });
  }
  if (
    execution.ok &&
    (output ||
      execution.data?.currentStateEvidence === true ||
      execution.data?.stateAlreadySatisfied === true)
  ) {
    const observation = output
      ? projectObservationOutput(output, directRoot)
      : {
          summary:
            "The capability confirmed the requested external state without a mutation.",
        };
    return Object.freeze({
      result: Object.freeze({
        outcome: "succeeded",
        observedEffect: "observation",
        ...observation,
      }),
    });
  }
  const observedEffect =
    execution.data?.mutationEvidence === true
      ? ("mutation" as const)
      : execution.data?.currentStateEvidence === true ||
          execution.data?.stateAlreadySatisfied === true
        ? ("observation" as const)
        : ("none" as const);
  return Object.freeze({
    result: Object.freeze({
      outcome: "failed",
      observedEffect,
      summary: boundedSummary(
        nonEmpty(execution.error) ??
          output ??
          (execution.ok
            ? "The mixed capability returned no usable observation or mutation evidence."
            : "The mixed capability reported an execution failure."),
        directRoot,
      ),
    }),
    sourceIssueCode:
      safeIssueCode(execution.errorCode) ??
      (execution.ok
        ? "mixed_effect_evidence_missing"
        : "tool_execution_failed"),
  });
}

function observeMutationResult(
  execution: ToolExecutionResult,
  completionActions: readonly ToolActionSummary[],
  directRoot: boolean,
): ProjectedExternalResult {
  const output = nonEmpty(execution.output);
  if (execution.ok && execution.data?.mutationEvidence === true) {
    const references = projectToolTargetReferences(completionActions);
    const referenceData = projectMutationGrounding(
      execution.data?.mutationGrounding,
      directRoot,
    );
    return Object.freeze({
      result: Object.freeze({
        outcome: "succeeded",
        observedEffect: "mutation",
        summary: summarizeCompletedMutation(completionActions),
        ...(referenceData ? { referenceData } : {}),
        ...(references.length > 0 ? { references } : {}),
      }),
    });
  }
  const observedEffect =
    execution.data?.mutationEvidence === true
      ? ("mutation" as const)
      : execution.data?.currentStateEvidence === true ||
          execution.data?.stateAlreadySatisfied === true
        ? ("observation" as const)
        : ("none" as const);
  return Object.freeze({
    result: Object.freeze({
      outcome: "failed",
      observedEffect,
      summary: boundedSummary(
        nonEmpty(execution.error) ??
          output ??
          (execution.ok
            ? "The capability returned no explicit mutation evidence."
            : "The mutation capability reported an execution failure."),
        directRoot,
      ),
    }),
    sourceIssueCode:
      safeIssueCode(execution.errorCode) ??
      (execution.ok ? "mutation_evidence_missing" : "tool_execution_failed"),
  });
}
export {
  attachTargetReferences,
  boundedSummary,
  projectSelectedTargetReferences,
  requireCapabilityAdapterResult,
} from "./result-evidence.js";
