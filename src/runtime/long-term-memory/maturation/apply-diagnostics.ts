import { performance } from "node:perf_hooks";
import { traceDebug } from "../../observability/debug-logger.js";
import type { ApplyLearningDecisionsInput, LearningMemoryReceipt } from "./contracts.js";

type ApplyStage = "validation" | "admission" | "binding" | "embedding" | "commit";

/** One content-free terminal event; original errors remain owned by the caller. */
export function createLearningApplyDiagnostics(input: ApplyLearningDecisionsInput) {
  const startedAt = performance.now();
  let stage: ApplyStage = "validation";
  let stageStartedAt = startedAt;
  let embeddingCount = 0;
  const stageDurationMs: Record<ApplyStage, number> = {
    validation: 0, admission: 0, binding: 0, embedding: 0, commit: 0,
  };

  function settleStage(): number {
    const endedAt = performance.now();
    stageDurationMs[stage] += endedAt - stageStartedAt;
    stageStartedAt = endedAt;
    return endedAt;
  }

  function finish(receipt?: LearningMemoryReceipt, receiptReused = false, error?: unknown): void {
    const endedAt = settleStage();
    const completed = receipt !== undefined;
    traceDebug("runtime.long_term_memory", completed ? "learning.apply_completed" : "learning.apply_failed", {
      requestId: `learning:${input.batchId}`,
      batchId: input.batchId,
      mode: input.cause?.kind === "scheduled_knowledge_review" ? "scheduled" : input.cause?.kind === "conversation_memory_review" ? "conversation" : "observations",
      stage,
      status: completed ? "completed" : input.abortSignal.aborted ? "cancelled" : "failed",
      durationMs: Math.round(endedAt - startedAt),
      stageDurationMs: Object.fromEntries(Object.entries(stageDurationMs).map(([key, value]) => [key, Math.round(value)])),
      decisionCount: Array.isArray(input.decisions) ? input.decisions.length : 0,
      observationCount: input.observations.length,
      knowledgeEntryCount: input.context.entries.length,
      embeddingCount,
      receiptReused,
      ...(completed ? {
        recordCount: receipt.recordIds.length,
        candidateCount: receipt.candidateIds.length,
        removedCandidateCount: receipt.removedCandidateCount,
      } : { errorType: input.abortSignal.aborted ? "abort" : error instanceof Error ? "error" : "non_error" }),
    });
  }

  return {
    enter(next: ApplyStage) { settleStage(); stage = next; },
    embedded(count: number) { embeddingCount = count; },
    completed(receipt: LearningMemoryReceipt, receiptReused = false) { finish(receipt, receiptReused); },
    failed(error: unknown) { finish(undefined, false, error); },
  };
}
