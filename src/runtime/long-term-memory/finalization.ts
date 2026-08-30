import type {
  LongTermMemoryService,
  MemoryCandidate,
} from "./contracts.js";
import { classifyMemoryFailure } from "./diagnostics.js";
import { traceDebug } from "../observability/debug-logger.js";

export function scheduleFinalResponseMemory(params: {
  service?: LongTermMemoryService;
  candidates?: readonly MemoryCandidate[];
  requestId: string;
  sessionId: string;
  onEvent?: (name: string, extra?: Record<string, unknown>) => void;
}): void {
  if (!params.service?.enabled || !params.candidates?.length) {
    return;
  }
  try {
    params.service.scheduleCandidates({
      candidates: params.candidates,
      context: {
        requestId: params.requestId,
        sessionId: params.sessionId,
        ...(params.onEvent ? { onEvent: params.onEvent } : {}),
      },
    });
  } catch (error) {
    traceDebug("runtime.long_term_memory", "save.scheduling_isolated", {
      requestId: params.requestId,
      reason: classifyMemoryFailure(error),
      candidateCount: params.candidates.length,
    });
  }
}
