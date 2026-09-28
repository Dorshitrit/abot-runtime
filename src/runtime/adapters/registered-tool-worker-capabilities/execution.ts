import { createTechnicalExecutionFailureResult } from "../../orchestration/worker-capabilities/execution/adapter-result-normalization.js";
import { createWorkerCapabilityExecutionErrorOutcomeFingerprint } from "../../orchestration/worker-capabilities/outcome-fingerprint.js";
import { createPreparedWorkerInvocation } from "./prepared-execution.js";
import {
  restorePreparedWorkerInvocation,
  createPreparedRejectionSnapshot,
} from "./prepared-snapshot.js";
import type { ToolExecutionSharedState } from "../../../capabilities/tool-types.js";
import {
  assertWorkerCapabilityWithinScope,
  projectWorkerCapabilityScope,
  WorkerCapabilityScopeError,
  type WorkerCapabilityAdapter,
  type WorkerCapabilityAdapterResult,
  type WorkerCapabilityAdapterPreparationInput,
  type WorkerCapabilityDescriptor,
  type WorkerCapabilityPayloadAuthor,
  type WorkerCapabilityPreparedExecution,
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
import { createRegisteredToolPreparationAttemptFingerprint } from "../registered-tool-normal-invocations/shared/action-fingerprint.js";
import { createWorkerCapabilityPreparationFailureFingerprint } from "../../orchestration/worker-capabilities/preparation-fingerprint.js";
import { createDeferredPayloadObservability } from "./payload-observability.js";

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
  return Object.freeze({
    descriptor: params.descriptor,
    async prepare(input) {
      return prepareRegisteredToolWorkerAdapter(params, input);
    },
    async restore(input, snapshot) {
      return restorePreparedWorkerInvocation(params, input, snapshot);
    },
    async execute(input) {
      const preparationInput = Object.freeze({
        ...input,
        preparationId: input.executionId,
      });
      const prepared = await prepareRegisteredToolWorkerAdapter(
        params,
        preparationInput,
      );
      return prepared.execute(input.executionId);
    },
  });
}

async function prepareRegisteredToolWorkerAdapter<TContext>(
  params: Parameters<typeof prepareRegisteredToolWorkerCapability<TContext>>[0],
  input: WorkerCapabilityAdapterPreparationInput<TContext>,
): Promise<WorkerCapabilityPreparedExecution> {
  const operationId = params.projection.operation.operationId;
  const payloadObservability = createDeferredPayloadObservability({
    executor: params.executor,
    diagnostic: params.diagnostic,
    operationId,
    call: input.call,
  });
  try {
    return await prepareRegisteredToolWorkerCapability(
      params,
      input,
      payloadObservability,
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const actionFingerprint =
      createWorkerCapabilityPreparationFailureFingerprint({
        capabilityId: params.descriptor.capabilityId,
        controls: input.controls,
        ...(input.call.workingDirectory
          ? { workingDirectory: input.call.workingDirectory }
          : {}),
        error,
      });
    const failedResult = {
      ...createTechnicalExecutionFailureResult(error),
      failureOutcomeFingerprint:
        createWorkerCapabilityExecutionErrorOutcomeFingerprint(error) ?? null,
    } as WorkerCapabilityAdapterResult;
    return Object.freeze({
      ...(actionFingerprint ? { actionFingerprint } : {}),
      acceptedControls: input.controls,
      snapshot: createPreparedRejectionSnapshot(
        operationId,
        actionFingerprint!,
        input.controls,
        failedResult,
      ),
      onAdmitted: payloadObservability.release,
      execute: async (executionId: string) => {
        payloadObservability.release(executionId);
        tracePreparedExecutionFailed(
          params,
          input,
          operationId,
          executionId,
          error,
          registeredPreparationFailureIssueCode(error),
        );
        throw error;
      },
    });
  }
}

async function prepareRegisteredToolWorkerCapability<TContext>(
  params: Readonly<{
    projection: RegisteredToolNormalInvocationProjection;
    descriptor: WorkerCapabilityDescriptor;
    scopeDescriptors: readonly WorkerCapabilityDescriptor[];
    executor: RegisteredToolNormalInvocationExecutor;
    sharedState: ToolExecutionSharedState;
    diagnostic: RegisteredToolWorkerCapabilityProviderDiagnostic;
    payloadAuthor?: WorkerCapabilityPayloadAuthor;
  }>,
  input: WorkerCapabilityAdapterPreparationInput<TContext>,
  payloadObservability: ReturnType<typeof createDeferredPayloadObservability>,
): Promise<WorkerCapabilityPreparedExecution> {
  const operationId = params.projection.operation.operationId;
  assertPreparedCapabilityScope(params, input, operationId);

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
    executor: payloadObservability.lifecycleEmitter,
    sharedState: params.sharedState,
    ...(params.payloadAuthor ? { payloadAuthor: params.payloadAuthor } : {}),
    call: input.call,
    ...(input.assignmentProvenance
      ? { assignmentProvenance: input.assignmentProvenance }
      : {}),
    // The payload contract still names this correlation executionId. During
    // prepare it is deliberately non-canonical and never enters the ledger.
    executionId: input.preparationId,
    descriptor: params.descriptor,
    intent: input.intent,
    ...(input.authoringObjective
      ? { authoringObjective: input.authoringObjective }
      : {}),
    controls: effectiveControls,
    ...(input.dependencyResults
      ? { dependencyResults: input.dependencyResults }
      : {}),
    settledCapabilityResults: input.settledCapabilityResults,
    deferPayloadStageMaterialized:
      payloadObservability.deferPayloadStageMaterialized,
    ...(input.executionFreshness
      ? { executionFreshness: input.executionFreshness }
      : {}),
  });
  if (preparedPayload.status === "rejected") {
    return preparedRuntimeRejection({
      params,
      input,
      operationId,
      effectiveControls,
      selectedTargetReferences,
      rejectedExecution: preparedPayload,
      payloadObservability,
    });
  }

  const normalPreparation = params.executor.prepare({
    handle: params.projection.handle,
    controls: effectiveControls,
    ...(preparedPayload.body === undefined
      ? {}
      : { payload: preparedPayload.body }),
    ...(preparedPayload.materializedParams === undefined
      ? {}
      : { materializedParams: preparedPayload.materializedParams }),
    intent: input.intent,
  });
  if (normalPreparation.status === "rejected") {
    const canonicalRejection = payloadRejection(
      normalPreparation.code,
      normalPreparation.message,
    );
    return preparedRuntimeRejection({
      params,
      input,
      operationId,
      effectiveControls,
      selectedTargetReferences,
      rejectedExecution: canonicalRejection,
      payloadObservability,
      emitRejection: params.executor.prepareRejectionEvent({
        handle: params.projection.handle,
        controls: effectiveControls,
        intent: input.intent,
      }),
      ...(preparedPayload.body === undefined
        ? {}
        : { payload: preparedPayload.body }),
      ...(preparedPayload.materializedParams === undefined
        ? {}
        : { materializedParams: preparedPayload.materializedParams }),
    });
  }

  return createPreparedWorkerInvocation(
    params,
    input,
    normalPreparation,
    selectedTargetReferences,
    payloadObservability,
  );
}

function preparedRuntimeRejection<TContext>(input: {
  params: Parameters<typeof prepareRegisteredToolWorkerCapability<TContext>>[0];
  input: WorkerCapabilityAdapterPreparationInput<TContext>;
  operationId: string;
  effectiveControls: Readonly<Record<string, unknown>>;
  selectedTargetReferences: ReturnType<typeof projectSelectedTargetReferences>;
  rejectedExecution: ReturnType<typeof payloadRejection>;
  payloadObservability: ReturnType<typeof createDeferredPayloadObservability>;
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
        tracePreparedExecutionStarted(
          input.params,
          input.input,
          input.operationId,
          executionId,
        );
        input.emitRejection?.({
          executionId,
          executorIdentity: input.input.call,
          errorCode: input.rejectedExecution.sourceIssueCode,
        });
        return completeRuntimeRejection({ ...input, executionId });
      } catch (error: unknown) {
        tracePreparedExecutionFailed(
          input.params,
          input.input,
          input.operationId,
          executionId,
          error,
        );
        throw error;
      }
    },
  });
}

function completeRuntimeRejection<TContext>(input: {
  params: Parameters<typeof prepareRegisteredToolWorkerCapability<TContext>>[0];
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

function assertPreparedCapabilityScope<TContext>(
  params: Parameters<typeof prepareRegisteredToolWorkerCapability<TContext>>[0],
  input: WorkerCapabilityAdapterPreparationInput<TContext>,
  operationId: string,
): void {
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
    throw scopedError;
  }
}

function tracePreparedExecutionStarted<TContext>(
  params: Parameters<typeof prepareRegisteredToolWorkerCapability<TContext>>[0],
  input: WorkerCapabilityAdapterPreparationInput<TContext>,
  operationId: string,
  executionId: string,
): void {
  traceRegisteredToolWorkerCapabilityExecutionStarted(
    params.diagnostic,
    operationId,
    input.call,
    executionId,
    input.intent.length,
    Object.keys(input.controls).length,
  );
}

function tracePreparedExecutionFailed<TContext>(
  params: Parameters<typeof prepareRegisteredToolWorkerCapability<TContext>>[0],
  input: WorkerCapabilityAdapterPreparationInput<TContext>,
  operationId: string,
  executionId: string,
  error: unknown,
  issueCode = error instanceof RegisteredToolWorkerCapabilityExecutionError
    ? error.issueCode
    : "execution_failed",
): void {
  traceRegisteredToolWorkerCapabilityExecutionFailed(
    params.diagnostic,
    operationId,
    input.call,
    executionId,
    error,
    issueCode,
  );
}

function registeredPreparationFailureIssueCode(error: unknown): string {
  return error instanceof RegisteredToolWorkerCapabilityExecutionError ||
    error instanceof RegisteredToolWorkerCapabilityCompositionError
    ? error.issueCode
    : "execution_failed";
}
