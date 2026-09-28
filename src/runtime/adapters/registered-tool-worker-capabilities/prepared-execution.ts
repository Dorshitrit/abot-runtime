import type { RoleCallFrame } from "../../orchestration/role-calls/index.js";
import type {
  WorkerCapabilityPreparedExecution,
  WorkerCapabilityExecutionFreshness,
  WorkerCapabilityDescriptor,
} from "../../orchestration/worker-capabilities/index.js";
import type {
  RegisteredToolNormalInvocationProjection,
  RegisteredToolPreparedNormalInvocation,
} from "../registered-tool-normal-invocations.js";
import {
  traceRegisteredToolWorkerCapabilityExecutionStarted,
  traceRegisteredToolWorkerCapabilityExecutionCompleted,
  traceRegisteredToolWorkerCapabilityExecutionFailed,
  type RegisteredToolWorkerCapabilityProviderDiagnostic,
} from "../registered-tool-worker-capability-diagnostics.js";
import { executionFreshnessRejection } from "./payload-lifecycle.js";
import { RegisteredToolWorkerCapabilityExecutionError } from "./errors.js";
import {
  observeExternalResult,
  attachTargetReferences,
  projectSelectedTargetReferences,
} from "./result-observer.js";

export function createPreparedWorkerInvocation(
  params: {
    projection: RegisteredToolNormalInvocationProjection;
    descriptor: WorkerCapabilityDescriptor;
    diagnostic: RegisteredToolWorkerCapabilityProviderDiagnostic;
  },
  input: {
    call: RoleCallFrame;
    intent: string;
    controls: Readonly<Record<string, unknown>>;
    executionFreshness?: WorkerCapabilityExecutionFreshness;
  },
  normalPreparation: RegisteredToolPreparedNormalInvocation,
  selectedTargetReferences: ReturnType<typeof projectSelectedTargetReferences>,
  payloadObservability: { release(executionId: string): void },
): WorkerCapabilityPreparedExecution {
  const operationId = params.projection.operation.operationId;
  return Object.freeze({
    actionFingerprint: normalPreparation.actionFingerprint,
    acceptedControls: normalPreparation.acceptedControls,
    snapshot: Object.freeze({
      kind: "registered_worker_invocation_v1",
      capabilityId: operationId,
      normal: normalPreparation.snapshot,
      selectedTargetReferences,
    }),
    ...(normalPreparation.approvalRequest
      ? { approvalRequest: normalPreparation.approvalRequest }
      : {}),
    applyApprovalDecision: normalPreparation.applyApprovalDecision,
    onAdmitted: payloadObservability.release,
    execute: async (executionId: string) => {
      try {
        payloadObservability.release(executionId);
        traceRegisteredToolWorkerCapabilityExecutionStarted(
          params.diagnostic,
          operationId,
          input.call,
          executionId,
          input.intent.length,
          Object.keys(input.controls).length,
        );
        const rejectedExecution = executionFreshnessRejection(
          input.executionFreshness,
        );
        if (rejectedExecution) {
          normalPreparation.emitRejection({
            executionId,
            executorIdentity: input.call,
            errorCode: rejectedExecution.sourceIssueCode,
          });
          return attachTargetReferences(
            {
              ...rejectedExecution.result,
              exactResult: rejectedExecution.exactResult,
            },
            selectedTargetReferences,
          );
        }
        const externalResult = await normalPreparation.execute(
          executionId,
          input.call,
        );
        const observed = observeExternalResult(
          externalResult,
          params.projection.operation.effect,
          input.call.parentCallId === null,
        );
        const observedResult = attachTargetReferences(
          observed.result,
          selectedTargetReferences,
        );
        traceRegisteredToolWorkerCapabilityExecutionCompleted(
          params.diagnostic,
          operationId,
          input.call,
          executionId,
          observedResult,
          externalResult.status,
          {
            ...(observed.sourceIssueCode
              ? { sourceIssueCode: observed.sourceIssueCode }
              : {}),
            summaryProjection:
              externalResult.status === "executed" &&
              observedResult.outcome === "succeeded" &&
              observedResult.observedEffect === "mutation"
                ? externalResult.completionActions.length > 0
                  ? "logical_completion_actions"
                  : "mutation_evidence_only"
                : "bounded_external_result",
            completionActions:
              externalResult.status === "executed"
                ? externalResult.completionActions
                : Object.freeze([]),
          },
        );
        return observedResult;
      } catch (error: unknown) {
        traceRegisteredToolWorkerCapabilityExecutionFailed(
          params.diagnostic,
          operationId,
          input.call,
          executionId,
          error,
          error instanceof RegisteredToolWorkerCapabilityExecutionError
            ? error.issueCode
            : "execution_failed",
        );
        throw error;
      }
    },
  });
}
