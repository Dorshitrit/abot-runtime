import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { SupervisorResponseDiagnosticContext } from "./contracts.js";

const SUPERVISOR_LOG_SCOPE = "runtime.supervisor";

export function traceSupervisorResponseContextProjected(params: {
  diagnostic: SupervisorResponseDiagnosticContext;
  context: RequestContextProjection;
  historyMessageCount: number;
  attachmentCount: number;
  referenceMessageCount: number;
  responseRecommendationLength: number;
  continuationMessageCount: number;
  completedChildResultCount: number;
  completedChildSummaryLength: number;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "response.context.projected", {
    ...baseFields(params.diagnostic),
    historyMessageCount: params.historyMessageCount,
    selectedHistoryMessageCount:
      params.context.selectedHistoryMessageIds.length,
    omittedHistoryMessageCount: params.context.omittedHistoryMessageIds.length,
    messageCount: params.context.messages.length,
    messageCharacterCount: params.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    attachmentCount: params.attachmentCount,
    referenceMessageCount: params.referenceMessageCount,
    responseRecommendationLength: params.responseRecommendationLength,
    continuationMessageCount: params.continuationMessageCount,
    completedChildResultCount: params.completedChildResultCount,
    completedChildSummaryLength: params.completedChildSummaryLength,
    projectContextIncluded: false,
    plannedWorkContextIncluded: false,
    capabilityContextIncluded: false,
    estimatedInputTokens: params.context.budget.estimatedInputTokens,
    availableInputTokens: params.context.budget.availableInputTokens,
  });
}

export function traceSupervisorResponseModelStarted(params: {
  diagnostic: SupervisorResponseDiagnosticContext;
  messageCount: number;
  messageCharacterCount: number;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "response.model.started", {
    ...baseFields(params.diagnostic),
    messageCount: params.messageCount,
    messageCharacterCount: params.messageCharacterCount,
  });
}

export function traceSupervisorResponseModelCompleted(params: {
  diagnostic: SupervisorResponseDiagnosticContext;
  durationMs: number;
  outputLength: number;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "response.model.completed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    outputLength: params.outputLength,
  });
}

export function traceSupervisorResponseModelFailed(params: {
  diagnostic: SupervisorResponseDiagnosticContext;
  durationMs: number;
  errorType: string;
}): void {
  traceDebug(SUPERVISOR_LOG_SCOPE, "response.model.failed", {
    ...baseFields(params.diagnostic),
    durationMs: params.durationMs,
    errorType: params.errorType,
  });
}

function baseFields(
  diagnostic: SupervisorResponseDiagnosticContext,
): Record<string, unknown> {
  return {
    requestId: diagnostic.requestId,
    role: "supervisor",
    modelStep: diagnostic.modelStep,
    rootCallId: diagnostic.rootCallId,
    callId: diagnostic.callId,
    parentCallId: diagnostic.parentCallId,
    depth: diagnostic.depth,
    invocationAttempt: diagnostic.invocationAttempt,
  };
}
