import type { ToolExecutionSharedState } from "../../../capabilities/tool-types.js";
import {
  assertWorkerCapabilityWithinScope,
  projectWorkerCapabilityScope,
  WorkerCapabilityScopeError,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityAdapterResult,
  type WorkerCapabilityDescriptor,
  type WorkerCapabilityPayloadAuthor,
} from "../../orchestration/worker-capabilities/index.js";
import type {
  RegisteredToolNormalInvocationExecutor,
  RegisteredToolNormalInvocationProjection,
} from "../registered-tool-normal-invocations.js";
import {
  traceRegisteredToolWorkerCapabilityExecutionCompleted,
  traceRegisteredToolWorkerCapabilityExecutionFailed,
  traceRegisteredToolWorkerCapabilityExecutionStarted,
  type RegisteredToolWorkerCapabilityProviderDiagnostic,
} from "../registered-tool-worker-capability-diagnostics.js";
import {
  RegisteredToolWorkerCapabilityCompositionError,
  RegisteredToolWorkerCapabilityExecutionError,
} from "./errors.js";
import {
  executionFreshnessRejection,
  payloadRejection,
  prepareOperationPayload,
} from "./payload-lifecycle.js";
import {
  attachTargetReferences,
  observeExternalResult,
  projectSelectedTargetReferences,
} from "./result-observer.js";
import { resolveEffectiveOperationTargetControls } from "./runtime-path-controls.js";

export function projectWorkerAdapters<TContext>(
  params: Readonly<{
    operationIds: readonly string[];
    descriptors: readonly WorkerCapabilityDescriptor[];
    executor: RegisteredToolNormalInvocationExecutor;
    sharedState: ToolExecutionSharedState;
    diagnostic: RegisteredToolWorkerCapabilityProviderDiagnostic;
    payloadAuthor?: WorkerCapabilityPayloadAuthor;
  }>,
): readonly WorkerCapabilityAdapter<TContext>[] {
  const projections = new Map<
    string,
    RegisteredToolNormalInvocationProjection
  >();
  for (const projection of params.executor.operations) {
    const operationId = projection.operation.operationId;
    if (projections.has(operationId)) {
      throw new RegisteredToolWorkerCapabilityCompositionError(
        "projected_operation_ambiguous",
        operationId,
      );
    }
    projections.set(operationId, projection);
  }
  const descriptors = new Map(
    params.descriptors.map((descriptor) => [
      descriptor.capabilityId,
      descriptor,
    ]),
  );

  return Object.freeze(
    params.operationIds.map((operationId) => {
      const projection = projections.get(operationId);
      const descriptor = descriptors.get(operationId);
      if (!projection || !descriptor) {
        throw new RegisteredToolWorkerCapabilityCompositionError(
          "projected_operation_unavailable",
          operationId,
        );
      }
      return createWorkerAdapter<TContext>({
        projection,
        descriptor,
        scopeDescriptors: params.descriptors,
        executor: params.executor,
        sharedState: params.sharedState,
        diagnostic: params.diagnostic,
        ...(params.payloadAuthor
          ? { payloadAuthor: params.payloadAuthor }
          : {}),
      });
    }),
  );
}

function createWorkerAdapter<TContext>(
  params: Readonly<{
    projection: RegisteredToolNormalInvocationProjection;
    descriptor: WorkerCapabilityDescriptor;
    scopeDescriptors: readonly WorkerCapabilityDescriptor[];
    executor: RegisteredToolNormalInvocationExecutor;
    sharedState: ToolExecutionSharedState;
    diagnostic: RegisteredToolWorkerCapabilityProviderDiagnostic;
    payloadAuthor?: WorkerCapabilityPayloadAuthor;
  }>,
): WorkerCapabilityAdapter<TContext> {
  const operationId = params.projection.operation.operationId;
  const operationEffect = params.projection.operation.effect;
  return Object.freeze({
    descriptor: params.descriptor,
    async execute(input) {
      try {
        const capabilityScope = projectWorkerCapabilityScope({
          entries: params.scopeDescriptors,
          scope: input.call.workerCapabilityScope,
          descriptorOf: (descriptor) => descriptor,
        });
        assertWorkerCapabilityWithinScope(capabilityScope, params.descriptor);
      } catch (error: unknown) {
        const scopedError =
          error instanceof WorkerCapabilityScopeError
            ? new RegisteredToolWorkerCapabilityCompositionError(
                error.issueCode,
                operationId,
              )
            : error;
        traceRegisteredToolWorkerCapabilityExecutionFailed(
          params.diagnostic,
          operationId,
          input.call,
          input.executionId,
          scopedError,
          error instanceof WorkerCapabilityScopeError
            ? error.issueCode
            : "capability_scope_validation_failed",
        );
        throw scopedError;
      }
      traceRegisteredToolWorkerCapabilityExecutionStarted(
        params.diagnostic,
        operationId,
        input.call,
        input.executionId,
        input.intent.length,
        Object.keys(input.controls).length,
      );
      try {
        const effectiveControls = resolveEffectiveOperationTargetControls({
          descriptor: params.descriptor,
          controls: input.controls,
          runtimePathBindings:
            params.projection.runtimePathBindings ?? Object.freeze([]),
          workingDirectory: input.call.workingDirectory,
          sharedState: params.sharedState,
        });
        const selectedTargetReferences = projectSelectedTargetReferences(
          params.projection,
          effectiveControls,
          input.call.parentCallId === null
            ? params.descriptor.selectionControlIds
            : undefined,
        );
        const preparedPayload = await prepareOperationPayload({
          projection: params.projection,
          executor: params.executor,
          sharedState: params.sharedState,
          ...(params.payloadAuthor
            ? { payloadAuthor: params.payloadAuthor }
            : {}),
          call: input.call,
          executionId: input.executionId,
          descriptor: params.descriptor,
          intent: input.intent,
          controls: effectiveControls,
          ...(input.dependencyResults
            ? { dependencyResults: input.dependencyResults }
            : {}),
          settledCapabilityResults: input.settledCapabilityResults,
          diagnostic: params.diagnostic,
          ...(input.executionFreshness
            ? { executionFreshness: input.executionFreshness }
            : {}),
        });
        const completeRejectedExecution = (
          rejectedExecution: ReturnType<typeof payloadRejection>,
        ): WorkerCapabilityAdapterResult => {
          const canonicalResult = Object.freeze({
            ...rejectedExecution.result,
            exactResult: rejectedExecution.exactResult,
          });
          const preparedResult = attachTargetReferences(
            canonicalResult,
            selectedTargetReferences,
          );
          traceRegisteredToolWorkerCapabilityExecutionCompleted(
            params.diagnostic,
            operationId,
            input.call,
            input.executionId,
            preparedResult,
            "rejected",
            {
              sourceIssueCode: rejectedExecution.sourceIssueCode,
              summaryProjection: "runtime_rejection",
              completionActions: Object.freeze([]),
            },
          );
          return preparedResult;
        };
        if (preparedPayload.status === "rejected") {
          return completeRejectedExecution(preparedPayload);
        }
        const rejectedExecution = executionFreshnessRejection(
          input.executionFreshness,
        );
        if (rejectedExecution) {
          return completeRejectedExecution(rejectedExecution);
        }
        const externalResult = await params.executor.execute({
          handle: params.projection.handle,
          controls: effectiveControls,
          ...(preparedPayload.body === undefined
            ? {}
            : { payload: preparedPayload.body }),
          ...(preparedPayload.materializedParams === undefined
            ? {}
            : {
                materializedParams: preparedPayload.materializedParams,
              }),
          intent: input.intent,
        });
        const observed = observeExternalResult(
          externalResult,
          operationEffect,
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
          input.executionId,
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
          input.executionId,
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
