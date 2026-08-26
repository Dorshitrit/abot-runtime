import { traceDebug } from "../../observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../../observability/error-type.js";
import type { RoleCallFrame } from "../role-calls/index.js";
import type {
  WorkerCapabilityAdapterResult,
  WorkerCapabilityDescriptor,
  WorkerSettledCapabilityResult,
} from "./contracts.js";

const WORKER_CAPABILITY_LOG_SCOPE = "runtime.worker_capabilities";

export type WorkerCapabilityDiagnosticContext = Readonly<{
  requestId: string;
  call: RoleCallFrame;
  capabilityIds: readonly string[];
  scopeMode: "full" | "catalog_groups";
  scopeCatalogGroupIds: readonly string[];
  knownCatalogGroupCount: number;
  fullCapabilityCount: number;
  filteredCapabilityCount: number;
}>;

export function traceWorkerCapabilityBindingCreated(
  context: WorkerCapabilityDiagnosticContext,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "binding.created", {
    ...projectBinding(context),
  });
}

export function traceWorkerCapabilityBindingRejected(
  context: WorkerCapabilityDiagnosticContext,
  issueCode: string,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "binding.rejected", {
    ...projectBinding(context),
    issueCode,
  });
}

export function traceWorkerCapabilitySelectionResolved(
  context: WorkerCapabilityDiagnosticContext,
  descriptor: WorkerCapabilityDescriptor,
  intentLength: number,
  controlCount: number,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "selection.resolved", {
    ...projectSelection(context, descriptor),
    intentLength,
    controlCount,
  });
}

export function traceWorkerCapabilitySelectionRejected(
  context: WorkerCapabilityDiagnosticContext,
  params: Readonly<{
    issueCode: string;
    capabilityId?: string;
    errorType?: string;
    attemptedCallId?: string;
    attemptedInvocationAttempt?: number;
  }>,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "selection.rejected", {
    ...projectBinding(context),
    ...(params.capabilityId ? { capabilityId: params.capabilityId } : {}),
    issueCode: params.issueCode,
    ...(params.errorType ? { errorType: params.errorType } : {}),
    ...(params.attemptedCallId
      ? { attemptedCallId: params.attemptedCallId }
      : {}),
    ...(params.attemptedInvocationAttempt !== undefined
      ? { attemptedInvocationAttempt: params.attemptedInvocationAttempt }
      : {}),
  });
}

export function traceWorkerCapabilityContextProjected(
  context: WorkerCapabilityDiagnosticContext,
  descriptor: WorkerCapabilityDescriptor,
  settledResults: readonly WorkerSettledCapabilityResult[],
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "context.projected", {
    ...projectSelection(context, descriptor),
    settledCapabilityResultCount: settledResults.length,
    settledCapabilityExecutionIds: settledResults.map(
      (result) => result.executionId,
    ),
    settledCapabilityIds: settledResults.map((result) => result.capabilityId),
    settledCapabilitySummaryLength: settledResults.reduce(
      (total, result) => total + result.summary.length,
      0,
    ),
    settledCapabilityReferenceDataLength: settledResults.reduce(
      (total, result) => total + (result.referenceData?.length ?? 0),
      0,
    ),
    settledCapabilityReferenceCount: settledResults.reduce(
      (total, result) => total + (result.references?.length ?? 0),
      0,
    ),
  });
}

export function traceWorkerCapabilityContextRejected(
  context: WorkerCapabilityDiagnosticContext,
  descriptor: WorkerCapabilityDescriptor,
  issueCode: string,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "context.rejected", {
    ...projectSelection(context, descriptor),
    issueCode,
  });
}

export function traceWorkerCapabilityExecutionStarted(
  context: WorkerCapabilityDiagnosticContext,
  descriptor: WorkerCapabilityDescriptor,
  executionId: string,
  intentLength: number,
  controlCount: number,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "execution.started", {
    ...projectSelection(context, descriptor),
    executionId,
    intentLength,
    controlCount,
  });
}

export function traceWorkerCapabilityExecutionCompleted(
  context: WorkerCapabilityDiagnosticContext,
  descriptor: WorkerCapabilityDescriptor,
  result: WorkerCapabilityAdapterResult,
  executionId: string,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "execution.completed", {
    ...projectSelection(context, descriptor),
    executionId,
    outcome: result.outcome,
    observedEffect: result.observedEffect,
    summaryLength: result.summary.length,
    resultReferenceCount: result.references?.length ?? 0,
  });
}

export function traceWorkerCapabilityResultRejected(
  context: WorkerCapabilityDiagnosticContext,
  descriptor: WorkerCapabilityDescriptor,
  issueCode: string,
  executionId: string,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "result.rejected", {
    ...projectSelection(context, descriptor),
    executionId,
    validationStage: "adapter_result",
    issueCode,
  });
}

export function traceWorkerCapabilityExecutionFailed(
  context: WorkerCapabilityDiagnosticContext,
  descriptor: WorkerCapabilityDescriptor,
  error: unknown,
  executionId: string,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "execution.failed", {
    ...projectSelection(context, descriptor),
    executionId,
    errorType: classifyRuntimeErrorType(error),
  });
}

export function traceWorkerCapabilityStateRejected(
  context: WorkerCapabilityDiagnosticContext,
  descriptor: WorkerCapabilityDescriptor,
  params: Readonly<{
    phase: "begin" | "settle";
    issueCode: string;
    executionId?: string;
  }>,
): void {
  traceDebug(WORKER_CAPABILITY_LOG_SCOPE, "execution.state_rejected", {
    ...projectSelection(context, descriptor),
    statePhase: params.phase,
    issueCode: params.issueCode,
    ...(params.executionId ? { executionId: params.executionId } : {}),
  });
}

function projectBinding(context: WorkerCapabilityDiagnosticContext) {
  return {
    requestId: context.requestId,
    callId: context.call.callId,
    parentCallId: context.call.parentCallId,
    roleId: context.call.roleId,
    depth: context.call.depth,
    invocationAttempt: context.call.activationCount,
    availableCapabilityCount: context.capabilityIds.length,
    capabilityIds: context.capabilityIds,
    workerCapabilityScopeMode: context.scopeMode,
    workerCapabilityScopeCatalogGroupIds: context.scopeCatalogGroupIds,
    workerCapabilityKnownCatalogGroupCount: context.knownCatalogGroupCount,
    workerCapabilityFullCount: context.fullCapabilityCount,
    workerCapabilityFilteredCount: context.filteredCapabilityCount,
  };
}

function projectSelection(
  context: WorkerCapabilityDiagnosticContext,
  descriptor: WorkerCapabilityDescriptor,
) {
  return {
    ...projectBinding(context),
    capabilityId: descriptor.capabilityId,
    declaredEffect: descriptor.effect,
  };
}
