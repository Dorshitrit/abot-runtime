import type { SessionThinkingTraceEntry } from "../../sessions/types.js";
import type { AgentMode } from "../../shared/types.js";
import type { EventSink } from "../ports.js";
import { finalizeResponse } from "../orchestration/final-response/finalization.js";
import { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";
import type {
  RequestObservation,
  RequestOutputTextMode,
} from "../request/result.js";
import type { RequestSessionStore } from "../request/session-store.js";

type RequestFinalizationResult =
  | { status: "completed"; output: string }
  | { status: "failed" };

export function failRequest(params: {
  events: EventSink;
  error: string;
  details?: Record<string, unknown>;
}): void {
  params.events.event("thinking.completed");
  params.events.failed(params.error, params.details);
}

export async function finalizeRequest(params: {
  rawOutput: string;
  outputTextMode?: RequestOutputTextMode;
  events: EventSink;
  lifecycle: RequestLifecycle;
  sessionStore: Pick<RequestSessionStore, "appendMessage">;
  sessionId: string;
  requestId: string;
  agentMode: AgentMode;
  thinkingTrace?: SessionThinkingTraceEntry[];
  finalObservation?: RequestObservation;
}): Promise<RequestFinalizationResult> {
  if (!params.rawOutput.trim()) {
    failRequest({
      events: params.events,
      error: "invalid_final_output",
      details: {
        reason: "empty_final_output",
        stage: "chat_finalization",
      },
    });
    return { status: "failed" };
  }
  const output =
    params.outputTextMode === "exact"
      ? params.rawOutput
      : params.rawOutput.trim();

  params.lifecycle.markProgress("valid_final_output");
  const finalizationState = { stage: "finalization" };
  params.lifecycle.updateState(finalizationState);
  params.events.runtimeState(finalizationState);
  await finalizeResponse({
    events: params.events,
    sessionStore: params.sessionStore,
    sessionId: params.sessionId,
    requestId: params.requestId,
    agentMode: params.agentMode,
    output,
    grounding: "conversation",
    thinkingTrace: params.thinkingTrace,
    ...(params.finalObservation
      ? {
          observationMeta: params.finalObservation.observationMeta,
          observationContent: params.finalObservation.observationContent,
        }
      : {}),
  });

  return { status: "completed", output };
}
