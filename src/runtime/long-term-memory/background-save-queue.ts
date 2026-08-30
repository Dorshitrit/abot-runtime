import type {
  LongTermMemoryRequestContext,
  MemoryCandidate,
  MemoryCandidateProcessingResult,
} from "./contracts.js";
import { classifyMemoryFailure } from "./diagnostics.js";
import { traceDebug } from "../observability/debug-logger.js";

const DEFAULT_BACKGROUND_SAVE_TIMEOUT_MS = 60_000;

export type BackgroundMemorySave = Readonly<{
  candidates: readonly MemoryCandidate[];
  requestId: string;
  sessionId: string;
}>;

export type LongTermMemorySaveQueue = Readonly<{
  enqueue(save: BackgroundMemorySave): void;
  drain(): Promise<void>;
}>;

export function createLongTermMemorySaveQueue(params: {
  process(
    input: Readonly<{
      candidates: readonly MemoryCandidate[];
      context: LongTermMemoryRequestContext;
    }>,
  ): Promise<MemoryCandidateProcessingResult>;
  timeoutMs?: number;
}): LongTermMemorySaveQueue {
  const timeoutMs = resolveTimeout(params.timeoutMs);
  let pending: Promise<void> = Promise.resolve();

  return Object.freeze({
    enqueue(save) {
      const detached = detachSave(save);
      pending = pending.then(() =>
        runSave(params.process, detached, timeoutMs),
      );
    },
    drain: () => pending,
  });
}

async function runSave(
  process: Parameters<typeof createLongTermMemorySaveQueue>[0]["process"],
  save: BackgroundMemorySave,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("long_term_memory_background_save_timeout");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    await Promise.race([
      process({
        candidates: save.candidates,
        context: {
          requestId: save.requestId,
          sessionId: save.sessionId,
          abortSignal: controller.signal,
        },
      }),
      deadline,
    ]);
  } catch (error) {
    traceDebug("runtime.long_term_memory", "save.background_failed", {
      requestId: save.requestId,
      reason: classifyMemoryFailure(error),
      candidateCount: save.candidates.length,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function detachSave(save: BackgroundMemorySave): BackgroundMemorySave {
  return Object.freeze({
    candidates: Object.freeze(
      save.candidates.map((candidate) =>
        Object.freeze({
          content: candidate.content,
          tags: Object.freeze([...candidate.tags]),
        }),
      ),
    ),
    requestId: save.requestId,
    sessionId: save.sessionId,
  });
}

function resolveTimeout(configured: number | undefined): number {
  if (
    configured !== undefined &&
    (!Number.isSafeInteger(configured) || configured <= 0)
  ) {
    throw new TypeError("long_term_memory_background_save_timeout_invalid");
  }
  return configured ?? DEFAULT_BACKGROUND_SAVE_TIMEOUT_MS;
}
