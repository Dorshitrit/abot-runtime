import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityAdapterResult } from "../orchestration/worker-capabilities/index.js";
import type { ToolActionSummary } from "../../capabilities/tool-types.js";
import { traceDebug } from "../observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../observability/error-type.js";

const LOG_SCOPE = "runtime.registered_tool_worker_capabilities";

export type RegisteredToolWorkerCapabilityProviderDiagnostic = Readonly<{
  requestId: string;
  operationIds: readonly string[];
}>;

export function traceRegisteredToolWorkerCapabilityCatalogResolutionStarted(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
): void {
  traceDebug(LOG_SCOPE, "provider.catalog_resolution_started", {
    ...projectProvider(context),
  });
}

export function traceRegisteredToolWorkerCapabilityCatalogResolutionCompleted(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  descriptorCount: number,
): void {
  traceDebug(LOG_SCOPE, "provider.catalog_resolution_completed", {
    ...projectProvider(context),
    descriptorCount,
  });
}

export function traceRegisteredToolWorkerCapabilityCatalogResolutionRejected(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  params: Readonly<{
    issueCode: string;
    operationId?: string;
    error?: unknown;
  }>,
): void {
  traceDebug(LOG_SCOPE, "provider.catalog_resolution_rejected", {
    ...projectProvider(context),
    issueCode: params.issueCode,
    ...(params.operationId ? { operationId: params.operationId } : {}),
    ...(params.error === undefined
      ? {}
      : { errorType: classifyRuntimeErrorType(params.error) }),
  });
}

export function traceRegisteredToolWorkerCapabilityResolutionStarted(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
): void {
  traceDebug(LOG_SCOPE, "provider.resolution_started", {
    ...projectProvider(context),
  });
}

export function traceRegisteredToolWorkerCapabilityResolutionCompleted(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  adapterCount: number,
): void {
  traceDebug(LOG_SCOPE, "provider.resolution_completed", {
    ...projectProvider(context),
    adapterCount,
  });
}

export function traceRegisteredToolWorkerCapabilityResolutionRejected(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  params: Readonly<{
    issueCode: string;
    operationId?: string;
    error?: unknown;
  }>,
): void {
  traceDebug(LOG_SCOPE, "provider.resolution_rejected", {
    ...projectProvider(context),
    issueCode: params.issueCode,
    ...(params.operationId ? { operationId: params.operationId } : {}),
    ...(params.error === undefined
      ? {}
      : { errorType: classifyRuntimeErrorType(params.error) }),
  });
}

export function traceRegisteredToolWorkerCapabilityGuidanceStarted(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  operationId: string,
  toolName: string,
): void {
  traceDebug(LOG_SCOPE, "guidance.resolution_started", {
    ...projectProvider(context),
    operationId,
    capabilityId: operationId,
    toolName,
  });
}

export function traceRegisteredToolWorkerCapabilityGuidanceCompleted(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  operationId: string,
  toolName: string,
  contextLength: number,
): void {
  traceDebug(LOG_SCOPE, "guidance.resolution_completed", {
    ...projectProvider(context),
    operationId,
    capabilityId: operationId,
    toolName,
    contextLength,
  });
}

export function traceRegisteredToolWorkerCapabilityGuidanceFailed(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  operationId: string,
  toolName: string,
  error: unknown,
): void {
  traceDebug(LOG_SCOPE, "guidance.resolution_failed", {
    ...projectProvider(context),
    operationId,
    capabilityId: operationId,
    toolName,
    errorType: classifyRuntimeErrorType(error),
  });
}

export function traceRegisteredToolWorkerCapabilityExecutionStarted(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  operationId: string,
  call: RoleCallFrame,
  executionId: string,
  intentLength: number,
  controlCount: number,
): void {
  traceDebug(LOG_SCOPE, "adapter.execution_started", {
    ...projectExecution(context, operationId, call, executionId),
    intentLength,
    controlCount,
  });
}

export function traceRegisteredToolWorkerCapabilityPayloadStageMaterialized(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  operationId: string,
  call: RoleCallFrame,
  executionId: string,
  details: Readonly<{
    payloadStage: number;
    payloadStageCount: number;
    source: "manifest_literal";
    byteCount: number;
  }>,
): void {
  traceDebug(LOG_SCOPE, "adapter.payload_stage_materialized", {
    ...projectExecution(context, operationId, call, executionId),
    payloadStage: details.payloadStage,
    payloadStageCount: details.payloadStageCount,
    source: details.source,
    byteCount: details.byteCount,
  });
}

export function traceRegisteredToolWorkerCapabilityExecutionCompleted(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  operationId: string,
  call: RoleCallFrame,
  executionId: string,
  result: WorkerCapabilityAdapterResult,
  sourceStatus: "executed" | "rejected",
  details: Readonly<{
    sourceIssueCode?: string;
    summaryProjection:
      | "logical_completion_actions"
      | "mutation_evidence_only"
      | "bounded_external_result"
      | "runtime_rejection";
    completionActions: readonly ToolActionSummary[];
  }>,
): void {
  const logicalTargetLengths = details.completionActions.flatMap((action) =>
    action.target ? [action.target.length] : [],
  );
  traceDebug(LOG_SCOPE, "adapter.execution_completed", {
    ...projectExecution(context, operationId, call, executionId),
    sourceStatus,
    ...(details.sourceIssueCode
      ? { sourceIssueCode: details.sourceIssueCode }
      : {}),
    outcome: result.outcome,
    observedEffect: result.observedEffect,
    summaryLength: result.summary.length,
    referenceDataLength: result.referenceData?.length ?? 0,
    summaryProjection: details.summaryProjection,
    completionActionCount: details.completionActions.length,
    completionActionTypes: details.completionActions.map(
      (action) => action.type,
    ),
    logicalTargetCount: logicalTargetLengths.length,
    logicalTargetLengths,
  });
}

export function traceRegisteredToolWorkerCapabilityExecutionFailed(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  operationId: string,
  call: RoleCallFrame,
  executionId: string,
  error: unknown,
  protocolIssueCode: string,
): void {
  traceDebug(LOG_SCOPE, "adapter.execution_failed", {
    ...projectExecution(context, operationId, call, executionId),
    protocolIssueCode,
    errorType: classifyRuntimeErrorType(error),
  });
}

function projectProvider(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
) {
  return {
    requestId: context.requestId,
    configuredOperationCount: context.operationIds.length,
    operationIds: context.operationIds,
  };
}

function projectExecution(
  context: RegisteredToolWorkerCapabilityProviderDiagnostic,
  operationId: string,
  call: RoleCallFrame,
  executionId: string,
) {
  return {
    ...projectProvider(context),
    operationId,
    capabilityId: operationId,
    callId: call.callId,
    parentCallId: call.parentCallId,
    roleId: call.roleId,
    depth: call.depth,
    invocationAttempt: call.activationCount,
    executionId,
  };
}
