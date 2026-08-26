import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { RequestHistoryMessage } from "./request-context-contracts.js";
import { projectLatestCompleteConversationTurn } from "./request-context.js";

export const REQUEST_SOURCE_MESSAGE_KIND =
  "runtime_request_source_v1" as const;

const REQUEST_SOURCE_LOG_SCOPE = "runtime.request_source";

export type RequestSourceView = Readonly<{
  requestId: string;
  sourceRef: string;
  currentRequest: string;
  precedingTurn?: RequestSourcePrecedingTurn;
}>;

export type RequestSourcePrecedingTurn = Readonly<{
  user: RequestSourceTurnMessage;
  assistant: RequestSourceTurnMessage;
}>;

export type RequestSourceTurnMessage = Readonly<{
  id: string;
  content: string;
  requestId?: string;
}>;

/**
 * Projects the exact current user request without interpreting, selecting,
 * normalizing, or copying it into canonical orchestration state. When history
 * is supplied, it also projects the mechanically latest complete visible
 * conversation turn as bounded source data.
 */
export function projectRequestSource(params: Readonly<{
  requestId: string;
  prompt: string;
  modelStep: ModelStep;
  callId: string;
  historyMessages?: readonly RequestHistoryMessage[];
}>): RequestSourceView {
  try {
    if (
      params.requestId.trim().length === 0 ||
      params.callId.trim().length === 0 ||
      params.prompt.trim().length === 0
    ) {
      throw new Error("request_source_input_invalid");
    }
    const precedingTurn = projectPrecedingTurn(params.historyMessages ?? []);
    const view = Object.freeze({
      requestId: params.requestId,
      sourceRef: `request:${params.requestId}`,
      currentRequest: params.prompt,
      ...(precedingTurn ? { precedingTurn } : {}),
    });
    traceDebug(REQUEST_SOURCE_LOG_SCOPE, "projected", {
      requestId: params.requestId,
      modelStep: params.modelStep,
      callId: params.callId,
      sourceRef: view.sourceRef,
      currentRequestChars: view.currentRequest.length,
      precedingTurnIncluded: precedingTurn !== undefined,
      ...(precedingTurn
        ? {
            precedingTurnUserMessageId: precedingTurn.user.id,
            precedingTurnAssistantMessageId: precedingTurn.assistant.id,
            ...(precedingTurn.user.requestId
              ? { precedingTurnUserRequestId: precedingTurn.user.requestId }
              : {}),
            ...(precedingTurn.assistant.requestId
              ? {
                  precedingTurnAssistantRequestId:
                    precedingTurn.assistant.requestId,
                }
              : {}),
            precedingTurnUserChars: precedingTurn.user.content.length,
            precedingTurnAssistantChars: precedingTurn.assistant.content.length,
          }
        : {}),
    });
    return view;
  } catch (error: unknown) {
    traceDebug(REQUEST_SOURCE_LOG_SCOPE, "rejected", {
      requestId: params.requestId,
      modelStep: params.modelStep,
      callId: params.callId,
      issueCode:
        error instanceof Error &&
        error.message.startsWith("request_source_")
          ? error.message
          : "request_source_projection_failed",
    });
    throw error;
  }
}

export function buildRequestSourceMessage(view: RequestSourceView): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: REQUEST_SOURCE_MESSAGE_KIND,
      authority: "reference_data",
      sourceRef: view.sourceRef,
      currentRequest: view.currentRequest,
      ...(view.precedingTurn ? { precedingTurn: view.precedingTurn } : {}),
    }),
  });
}

function projectPrecedingTurn(
  historyMessages: readonly RequestHistoryMessage[],
): RequestSourcePrecedingTurn | undefined {
  const precedingTurn = projectLatestCompleteConversationTurn(historyMessages);
  if (!precedingTurn) {
    return undefined;
  }
  return Object.freeze({
    user: projectTurnMessage(precedingTurn[0]),
    assistant: projectTurnMessage(precedingTurn[1]),
  });
}

function projectTurnMessage(
  message: RequestHistoryMessage,
): RequestSourceTurnMessage {
  return Object.freeze({
    id: message.id,
    content: message.content,
    ...(message.requestId ? { requestId: message.requestId } : {}),
  });
}
