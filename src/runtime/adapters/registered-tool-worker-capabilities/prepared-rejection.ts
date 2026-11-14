import type {
  WorkerCapabilityAdapterPreparationInput,
  WorkerCapabilityAdapterResult,
  WorkerCapabilityPreparedExecution,
} from "../../orchestration/worker-capabilities/index.js";
import type { RegisteredToolNormalInvocationExecutor } from "../registered-tool-normal-invocations.js";
import {
  traceRegisteredToolWorkerCapabilityExecutionStarted,
  traceRegisteredToolWorkerCapabilityExecutionCompleted,
  traceRegisteredToolWorkerCapabilityExecutionFailed,
  type RegisteredToolWorkerCapabilityProviderDiagnostic,
} from "../registered-tool-worker-capability-diagnostics.js";
import { createRegisteredToolPreparationAttemptFingerprint } from "../registered-tool-normal-invocations/shared/action-fingerprint.js";
import { RegisteredToolWorkerCapabilityExecutionError } from "./errors.js";
import { payloadRejection } from "./payload-rejection.js";
import { createPreparedRejectionSnapshot } from "./prepared-snapshot.js";
import {
  attachTargetReferences,
  projectSelectedTargetReferences,
} from "./result-observer.js";

export function preparedRuntimeRejection<TContext>(input: {
  params: { diagnostic: RegisteredToolWorkerCapabilityProviderDiagnostic };
  input: WorkerCapabilityAdapterPreparationInput<TContext>;
  operationId: string;
  effectiveControls: Readonly<Record<string, unknown>>;
  selectedTargetReferences: ReturnType<typeof projectSelectedTargetReferences>;
  rejectedExecution: ReturnType<typeof payloadRejection>;
  payloadObservability: { release(executionId: string): void };
  emitRejection?: ReturnType<
    RegisteredToolNormalInvocationExecutor["prepareRejectionEvent"]
  >;
  payload?: string;
  materializedParams?: Readonly<Record<string, string>>;
}): WorkerCapabilityPreparedExecution {
  return Object.freeze({
    actionFingerprint: createRegisteredToolPreparationAttemptFingerprint({
      operationId: input.operationId,
      controls: input.effectiveControls,
      rejectionCode: input.rejectedExecution.sourceIssueCode,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      ...(input.materializedParams === undefined
        ? {}
        : { materializedParams: input.materializedParams }),
    }),
    acceptedControls: input.effectiveControls,
    snapshot: createPreparedRejectionSnapshot(
      input.operationId,
      createRegisteredToolPreparationAttemptFingerprint({
        operationId: input.operationId,
        controls: input.effectiveControls,
        rejectionCode: input.rejectedExecution.sourceIssueCode,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
        ...(input.materializedParams === undefined
          ? {}
          : { materializedParams: input.materializedParams }),
      }),
      input.effectiveControls,
      attachTargetReferences(
        {
          ...input.rejectedExecution.result,
          exactResult: input.rejectedExecution.exactResult,
        },
        input.selectedTargetReferences,
      ),
    ),
    onAdmitted: input.payloadObservability.release,
    execute: async (executionId: string) => {
      try {
        input.payloadObservability.release(executionId);
        traceRegisteredToolWorkerCapabilityExecutionStarted(
          input.params.diagnostic,
          input.operationId,
          input.input.call,
          executionId,
          input.input.intent?.length ?? 0,
          Object.keys(input.input.controls).length,
        );
        input.emitRejection?.({
          executionId,
          executorIdentity: input.input.call,
          errorCode: input.rejectedExecution.sourceIssueCode,
        });
        return completeRuntimeRejection({ ...input, executionId });
      } catch (error: unknown) {
        traceRegisteredToolWorkerCapabilityExecutionFailed(
          input.params.diagnostic,
          input.operationId,
          input.input.call,
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

function completeRuntimeRejection<TContext>(input: {
  params: { diagnostic: RegisteredToolWorkerCapabilityProviderDiagnostic };
  input: WorkerCapabilityAdapterPreparationInput<TContext>;
  operationId: string;
  executionId: string;
  selectedTargetReferences: ReturnType<typeof projectSelectedTargetReferences>;
  rejectedExecution: ReturnType<typeof payloadRejection>;
}): WorkerCapabilityAdapterResult {
  const canonicalResult = Object.freeze({
    ...input.rejectedExecution.result,
    exactResult: input.rejectedExecution.exactResult,
  });
  const preparedResult = attachTargetReferences(
    canonicalResult,
    input.selectedTargetReferences,
  );
  traceRegisteredToolWorkerCapabilityExecutionCompleted(
    input.params.diagnostic,
    input.operationId,
    input.input.call,
    input.executionId,
    preparedResult,
    "rejected",
    {
      sourceIssueCode: input.rejectedExecution.sourceIssueCode,
      summaryProjection: "runtime_rejection",
      completionActions: Object.freeze([]),
    },
  );
  return preparedResult;
}
