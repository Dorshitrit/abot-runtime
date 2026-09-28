import type { SessionThinkingTraceEntry } from "../../sessions/types.js";
import { throwIfRequestCancelled } from "../request/cancellation.js";
import type { AgentMode } from "../../shared/types.js";
import type { EventSink } from "../ports.js";
import { finalizeResponse } from "../orchestration/final-response/finalization.js";
import { RequestLifecycle } from "../orchestration/lifecycle/request-lifecycle.js";
import type {
  RequestObservation,
  RequestOutputTextMode,
} from "../request/result.js";
import type { RequestSessionStore } from "../request/session-store.js";
import type {
  LongTermMemoryService,
  MemoryCandidate,
} from "../long-term-memory/contracts.js";
import { scheduleFinalResponseMemory } from "../long-term-memory/finalization.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { SessionTerminalMessage } from "../../sessions/request-lifecycle/contracts.js";

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
  claimFinalization?: () => void;
  sessionStore: Pick<RequestSessionStore, "appendMessage">;
  sessionId: string;
  requestId: string;
  agentMode: AgentMode;
  thinkingTrace?: SessionThinkingTraceEntry[];
  finalObservation?: RequestObservation;
  memoryCandidates?: readonly MemoryCandidate[];
  longTermMemory?: LongTermMemoryService;
  composeInvalidFinalOutput?: () => Promise<string>;
  persistResponse?: (message: SessionTerminalMessage) => Promise<void>;
}): Promise<RequestFinalizationResult> {
  throwIfRequestCancelled(params.lifecycle.signal);
  const hasValidFinalOutput = params.rawOutput.trim().length > 0;
  if (!hasValidFinalOutput) {
    params.lifecycle.signal.throwIfAborted();
    traceDebug("runtime.request", "final_output.invalid", {
      requestId: params.requestId,
      code: "invalid_final_output",
      reason: "empty_final_output",
      stage: "chat_finalization",
      disposition: "degraded_authoring",
    });
  }
  const output = await resolveFinalizationOutput(
    params.rawOutput,
    params.outputTextMode,
    params.lifecycle.signal,
    params.composeInvalidFinalOutput,
  );
  if (!hasValidFinalOutput) params.lifecycle.signal.throwIfAborted();
  const finalObservation = hasValidFinalOutput
    ? params.finalObservation
    : undefined;
  const memoryCandidates = hasValidFinalOutput
    ? params.memoryCandidates
    : undefined;

  params.lifecycle.markProgress("valid_final_output");
  const finalizationState = { stage: "finalization" };
  params.lifecycle.updateState(finalizationState);
  params.events.runtimeState(finalizationState);
  throwIfRequestCancelled(params.lifecycle.signal);
  params.claimFinalization?.();
  await finalizeResponse({
    ...(params.persistResponse
      ? { persistResponse: params.persistResponse }
      : {}),
    events: params.events,
    sessionStore: params.sessionStore,
    sessionId: params.sessionId,
    requestId: params.requestId,
    agentMode: params.agentMode,
    output,
    grounding: "conversation",
    thinkingTrace: params.thinkingTrace,
    ...(finalObservation
      ? {
          observationMeta: finalObservation.observationMeta,
          observationContent: finalObservation.observationContent,
        }
      : {}),
    afterPersist: () =>
      scheduleFinalResponseMemory({
        service: params.longTermMemory,
        candidates: memoryCandidates,
        requestId: params.requestId,
        sessionId: params.sessionId,
        onEvent: params.events.event.bind(params.events),
      }),
  });

  return { status: "completed", output };
}

async function resolveFinalizationOutput(
  rawOutput: string,
  outputTextMode: RequestOutputTextMode | undefined,
  signal: AbortSignal,
  composeInvalidFinalOutput: (() => Promise<string>) | undefined,
): Promise<string> {
  const hasValidFinalOutput = rawOutput.trim().length > 0;
  if (hasValidFinalOutput) {
    return outputTextMode === "exact" ? rawOutput : rawOutput.trim();
  }
  const canComposeInvalidFinalOutput = composeInvalidFinalOutput !== undefined;
  if (!canComposeInvalidFinalOutput) throw new Error("invalid_final_output");
  const authored = await composeInvalidFinalOutput();
  signal.throwIfAborted();
  const hasValidDegradedOutput = authored.trim().length > 0;
  if (!hasValidDegradedOutput) throw new Error("invalid_final_output");
  return outputTextMode === "exact" ? authored : authored.trim();
}
