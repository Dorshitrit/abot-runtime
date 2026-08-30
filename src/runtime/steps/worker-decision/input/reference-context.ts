import { buildRequestTemporalContextMessage } from "../../../context/request-temporal-context.js";
import {
  buildRequestSourceMessage,
  projectRequestSource,
} from "../../../context/request-source.js";
import { buildRequestToolResultsMessage } from "../../../context/request-tool-results.js";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../../../context/operation-supervision-evidence.js";
import { buildRoleCallAssignmentScopeMessage } from "../../../orchestration/role-calls/index.js";
import type { WorkerResultAuthorSource } from "../contracts.js";
import type {
  PreparedWorkerDecisionSession,
  PreparedWorkerReferenceContext,
} from "./types.js";

export function prepareWorkerReferenceContext(
  session: PreparedWorkerDecisionSession,
): PreparedWorkerReferenceContext {
  const { request, options, callIdentity, objective, canonicalState } = session;
  const { assignmentScope, dependencyResults, operationSupervision, resume } =
    canonicalState;
  const requestSource = projectRequestSource({
    requestId: request.requestId,
    prompt: request.prompt,
    modelStep: session.diagnostic.modelStep,
    callId: callIdentity.callId,
    historyMessages: request.historyMessages,
  });
  const requestToolResultsMessage =
    options.requestToolResults.results.length > 0
      ? (options.requestToolResultsContextMessage ??
        buildRequestToolResultsMessage(options.requestToolResults))
      : undefined;
  if (operationSupervision && !canonicalState.canonicalSource) {
    throw new Error("worker_operation_supervision_source_missing");
  }
  const operationSupervisionEvidenceMessage =
    operationSupervision && canonicalState.canonicalSource
      ? buildImmediateOperationSupervisionEvidenceMessage(
          canonicalState.canonicalSource.head,
          options.call,
        )
      : undefined;
  if (operationSupervision && !operationSupervisionEvidenceMessage) {
    throw new Error("worker_operation_supervision_evidence_missing");
  }
  const resultAuthorSource: WorkerResultAuthorSource = Object.freeze({
    ...callIdentity,
    objective,
    dependencyResults,
    requestToolResults: options.requestToolResults,
    ...(requestToolResultsMessage
      ? { requestToolResultsContextMessage: requestToolResultsMessage }
      : {}),
    ...(operationSupervisionEvidenceMessage
      ? {
          operationSupervisionEvidenceContextMessage:
            operationSupervisionEvidenceMessage,
        }
      : {}),
  });
  const baseReferenceMessages = Object.freeze([
    ...(request.temporalContext
      ? [buildRequestTemporalContextMessage(request.temporalContext)]
      : []),
    buildRequestSourceMessage(requestSource),
    ...(assignmentScope
      ? [buildRoleCallAssignmentScopeMessage(assignmentScope)]
      : []),
    ...(!resume && requestToolResultsMessage
      ? [requestToolResultsMessage]
      : []),
    ...(operationSupervisionEvidenceMessage
      ? [operationSupervisionEvidenceMessage]
      : []),
  ]);
  const continuationMessages = Object.freeze([
    ...(resume && requestToolResultsMessage ? [requestToolResultsMessage] : []),
  ]);

  return Object.freeze({
    requestToolResultsMessage,
    operationSupervisionEvidenceMessage,
    resultAuthorSource,
    baseReferenceMessages,
    continuationMessages,
  });
}
