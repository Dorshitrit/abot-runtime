import { traceDebug } from "../../observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../../observability/error-type.js";
import type { RoleCallFrame } from "../role-calls/index.js";
import type { WorkerCapabilityDescriptor } from "./contracts.js";

const LOG_SCOPE = "runtime.worker_capability_payload";

export type WorkerCapabilityPayloadDiagnosticContext = Readonly<{
  requestId: string;
  call: RoleCallFrame;
  executionId: string;
  descriptor: WorkerCapabilityDescriptor;
  controlCount: number;
  minBytes: number;
  maxBytes: number;
  settledCapabilityResultCount: number;
  settledCapabilitySummaryLength: number;
  settledCapabilityReferenceDataLength: number;
  payloadContextCharacterCount: number;
  payloadStage?: number;
  payloadStageCount?: number;
  payloadOutputParam?: string;
  payloadResponseFormat?: "raw" | "json" | "schema";
  materializedParamCount?: number;
  targetContextCharacterCount?: number;
  targetContextTransport?: "verbatim_reference";
  targetContextPresentation?: "bounded" | "full" | "full_numbered";
  targetContextWritableStartLine?: number;
  targetContextWritableEndLine?: number;
  targetContextWindowStartLine?: number;
  targetContextWindowEndLine?: number;
  relatedArtifactContextCount: number;
  relatedArtifactContextCharacterCount: number;
  relatedArtifactContextTransport?: "verbatim_reference";
}>;

export function traceWorkerCapabilityPayloadStarted(
  context: WorkerCapabilityPayloadDiagnosticContext,
): void {
  traceDebug(LOG_SCOPE, "author.started", project(context));
}

export function traceWorkerCapabilityPayloadCompleted(
  context: WorkerCapabilityPayloadDiagnosticContext,
  payloadBytes: number,
): void {
  traceDebug(LOG_SCOPE, "author.completed", {
    ...project(context),
    payloadBytes,
  });
}

export function traceWorkerCapabilityPayloadFailed(
  context: WorkerCapabilityPayloadDiagnosticContext,
  issueCode: string,
  error?: unknown,
): void {
  traceDebug(LOG_SCOPE, "author.failed", {
    ...project(context),
    issueCode,
    ...(error === undefined
      ? {}
      : { errorType: classifyRuntimeErrorType(error) }),
  });
}

function project(context: WorkerCapabilityPayloadDiagnosticContext) {
  return {
    requestId: context.requestId,
    callId: context.call.callId,
    parentCallId: context.call.parentCallId,
    roleId: context.call.roleId,
    depth: context.call.depth,
    invocationAttempt: context.call.activationCount,
    executionId: context.executionId,
    capabilityId: context.descriptor.capabilityId,
    declaredEffect: context.descriptor.effect,
    controlCount: context.controlCount,
    minBytes: context.minBytes,
    maxBytes: context.maxBytes,
    settledCapabilityResultCount: context.settledCapabilityResultCount,
    settledCapabilitySummaryLength: context.settledCapabilitySummaryLength,
    settledCapabilityReferenceDataLength:
      context.settledCapabilityReferenceDataLength,
    payloadContextCharacterCount: context.payloadContextCharacterCount,
    relatedArtifactContextCount: context.relatedArtifactContextCount,
    relatedArtifactContextCharacterCount:
      context.relatedArtifactContextCharacterCount,
    ...(context.relatedArtifactContextTransport
      ? {
          relatedArtifactContextTransport:
            context.relatedArtifactContextTransport,
        }
      : {}),
    ...(context.payloadStage === undefined
      ? {}
      : { payloadStage: context.payloadStage }),
    ...(context.payloadStageCount === undefined
      ? {}
      : { payloadStageCount: context.payloadStageCount }),
    ...(context.payloadOutputParam === undefined
      ? {}
      : { payloadOutputParam: context.payloadOutputParam }),
    ...(context.payloadResponseFormat === undefined
      ? {}
      : { payloadResponseFormat: context.payloadResponseFormat }),
    ...(context.materializedParamCount === undefined
      ? {}
      : { materializedParamCount: context.materializedParamCount }),
    ...(context.targetContextCharacterCount === undefined
      ? {}
      : {
          targetContextCharacterCount: context.targetContextCharacterCount,
        }),
    ...(context.targetContextTransport === undefined
      ? {}
      : { targetContextTransport: context.targetContextTransport }),
    ...(context.targetContextPresentation === undefined
      ? {}
      : { targetContextPresentation: context.targetContextPresentation }),
    ...(context.targetContextWritableStartLine === undefined
      ? {}
      : {
          targetContextWritableStartLine:
            context.targetContextWritableStartLine,
          targetContextWritableEndLine: context.targetContextWritableEndLine,
          targetContextWindowStartLine: context.targetContextWindowStartLine,
          targetContextWindowEndLine: context.targetContextWindowEndLine,
        }),
  };
}
