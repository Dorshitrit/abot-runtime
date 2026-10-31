import type {
  SessionRequestTerminalCause,
  SessionTerminalMessage,
} from "../../../sessions/request-lifecycle/contracts.js";
import type { SessionThinkingTraceEntry } from "../../../sessions/types.js";
import { isRequestCancelled } from "../cancellation.js";
import { isRequestInterrupted } from "../interruption.js";
import { readModelGatewayUserMessage } from "../../../model-gateway/client.js";

export function classifyRequestTerminalCause(
  signal: AbortSignal,
): SessionRequestTerminalCause {
  if (isRequestCancelled(signal)) return "request_cancelled";
  if (isRequestInterrupted(signal)) return "request_interrupted";
  return "request_failed";
}

export function createRequestFailureMessage(params: {
  cause: SessionRequestTerminalCause;
  partialAnswer: string;
  thinkingTrace?: SessionThinkingTraceEntry[];
  error?: unknown;
}): SessionTerminalMessage {
  const acknowledgement = failureAcknowledgement(params.cause, params.error);
  const content = params.partialAnswer.trim()
    ? `${params.partialAnswer}\n\n${acknowledgement}`
    : acknowledgement;
  return {
    content,
    grounding: "conversation",
    ...(params.thinkingTrace ? { thinkingTrace: params.thinkingTrace } : {}),
  };
}

function failureAcknowledgement(cause: SessionRequestTerminalCause, error: unknown): string {
  if (cause === "request_cancelled")
    return "I stopped the task at your request.";
  if (cause === "request_interrupted")
    return "The request was interrupted when the runtime stopped.";
  const providerMessage = readModelGatewayUserMessage(error);
  if (providerMessage) return providerMessage;
  return "The request could not be completed.";
}
