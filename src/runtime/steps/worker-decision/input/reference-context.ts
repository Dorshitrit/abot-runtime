import { buildRequestTemporalContextMessage } from "../../../context/request-temporal-context.js";
import {
  buildRequestSourceMessage,
  projectRequestSource,
} from "../../../context/request-source.js";
import { buildRequestToolResultsMessage } from "../../../context/request-tool-results.js";
import { isRequestToolResultsMessageBoundToView } from "../../../context/request-tool-results-message-binding.js";
import { isRequestToolResultsViewValidForCallScope } from "../../../context/request-tool-results-scope.js";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../../../context/operation-supervision-evidence.js";
import { buildRoleCallAssignmentScopeMessage } from "../../../orchestration/role-calls/index.js";
import { isWorkerCapabilityAssignmentProvenanceValid } from "../../../orchestration/worker-capabilities/index.js";
import type { WorkerResultAuthorSource } from "../contracts.js";
import { projectWorkerPayloadDependencyResults } from "../payload-dependency-results.js";
import type {
  PreparedWorkerDecisionSession,
  PreparedWorkerReferenceContext,
} from "./types.js";

export function prepareWorkerReferenceContext(
  session: PreparedWorkerDecisionSession,
): PreparedWorkerReferenceContext {
  const { request, options, callIdentity, objective, canonicalState } = session;
  const {
    assignmentScope,
    assignmentProvenance,
    dependencyResults,
    operationSupervision,
    resume,
  } = canonicalState;
  if (
    !isWorkerCapabilityAssignmentProvenanceValid(
      assignmentProvenance,
      options.call,
      request.requestId,
    )
  ) {
    throw new Error("worker_assignment_provenance_receipt_invalid");
  }
  const planItemScoped = assignmentProvenance !== undefined;
  if (
    !isRequestToolResultsViewValidForCallScope(
      options.requestToolResults,
      callIdentity.callId,
      planItemScoped,
    )
  ) {
    throw new Error("worker_plan_item_tool_results_scope_invalid");
  }
  const requestSource = planItemScoped
    ? undefined
    : projectRequestSource({
        requestId: request.requestId,
        prompt: request.prompt,
        modelStep: session.diagnostic.modelStep,
        callId: callIdentity.callId,
        historyMessages: request.historyMessages,
      });
  const requestToolResults = options.requestToolResults;
  if (
    options.requestToolResultsContextMessage &&
    !isRequestToolResultsMessageBoundToView(
      options.requestToolResultsContextMessage,
      requestToolResults,
    )
  ) {
    throw new Error("worker_tool_results_message_binding_invalid");
  }
  const requestToolResultsMessage =
    requestToolResults.results.length > 0
      ? (options.requestToolResultsContextMessage ??
        buildRequestToolResultsMessage(requestToolResults))
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
  const resultAuthorDependencyResults =
    projectWorkerPayloadDependencyResults(dependencyResults);
  const resultAuthorSource: WorkerResultAuthorSource = Object.freeze({
    ...callIdentity,
    objective,
    ...(assignmentProvenance ? { assignmentProvenance } : {}),
    dependencyResults: resultAuthorDependencyResults,
    requestToolResults,
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
    ...(requestSource ? [buildRequestSourceMessage(requestSource)] : []),
    ...(assignmentScope && !planItemScoped
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
