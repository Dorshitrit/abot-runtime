import { buildRequestTemporalContextMessage } from "../../../context/request-temporal-context.js";
import {
  buildRequestSourceMessage,
  projectRequestSource,
} from "../../../context/request-source.js";
import { buildRequestToolResultsMessage } from "../../../context/request-tool-results.js";
import { buildRoleCallAssignmentScopeMessage } from "../../../orchestration/role-calls/index.js";
import {
  WORKER_DECISION_MODEL_STEP,
  type WorkerResultAuthorSource,
} from "../contracts.js";
import type {
  PreparedWorkerDecisionSession,
  PreparedWorkerReferenceContext,
} from "./types.js";

export function prepareWorkerReferenceContext(
  session: PreparedWorkerDecisionSession,
): PreparedWorkerReferenceContext {
  const { request, options, callIdentity, objective, canonicalState } = session;
  const { assignmentScope, dependencyResults, resume } = canonicalState;
  const requestSource = projectRequestSource({
    requestId: request.requestId,
    prompt: request.prompt,
    modelStep: WORKER_DECISION_MODEL_STEP,
    callId: callIdentity.callId,
    historyMessages: request.historyMessages,
  });
  const requestToolResultsMessage =
    options.requestToolResults.results.length > 0
      ? (options.requestToolResultsContextMessage ??
        buildRequestToolResultsMessage(options.requestToolResults))
      : undefined;
  const resultAuthorSource: WorkerResultAuthorSource = Object.freeze({
    ...callIdentity,
    objective,
    dependencyResults,
    requestToolResults: options.requestToolResults,
    ...(requestToolResultsMessage
      ? { requestToolResultsContextMessage: requestToolResultsMessage }
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
  ]);
  const continuationMessages = Object.freeze([
    ...(resume && requestToolResultsMessage ? [requestToolResultsMessage] : []),
  ]);

  return Object.freeze({
    requestToolResultsMessage,
    resultAuthorSource,
    baseReferenceMessages,
    continuationMessages,
  });
}
