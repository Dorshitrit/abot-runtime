import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningMemoryDecision } from "../long-term-memory/maturation/contracts.js";
import { parseLearningDecisions } from "../long-term-memory/maturation/decisions.js";
import { createLearningMemoryService } from "../long-term-memory/maturation/service.js";
import * as logger from "../observability/debug-logger.js";
import type { LearningBatch } from "../passive-learning/contracts.js";
import { processLearningBatch } from "../passive-learning/process-batch.js";
import { parseLearningReviewOutput } from "../passive-learning/review-output.js";
import { learningFailureReason, summarizeBatch } from "../passive-learning/status-projection.js";

afterEach(() => vi.restoreAllMocks());

function fixture(changes: Partial<LearningMemoryDecision> = {}) {
  const timestamp = "2026-09-25T12:00:00.000Z";
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn(async () => ({ modelFingerprint: "test", dimensions: 2, vectors: [[1, 0]] }));
  const learning = createLearningMemoryService({ repository, embeddings: { embed }, now: () => new Date(timestamp) });
  const decision: LearningMemoryDecision = {
    action: "create", targetKind: "candidate", targetId: null, targetVersion: null,
    content: "Prefers concise project summaries.", tags: ["workflow"], score: 45,
    reason: "An observed preference.", certainty: "observed", reinforced: true,
    observationIds: ["observation"], mergedCandidateIds: [], reconsiderAt: null, ...changes,
  };
  let latest: LearningBatch = {
    id: "batch", generation: "generation", createdAt: timestamp, status: "pending", recordIds: [],
    observations: [{ id: "observation", deviceId: "device", timestamp, sequence: 1,
      source: { app: "editor", windowId: "window" }, content: "Private screen text", kind: "view", extraction: "uia", coverage: "partial" }],
  };
  const review = vi.fn(async () => parseLearningDecisions(JSON.stringify({ decisions: [decision] })));
  const trace = vi.spyOn(logger, "traceDebug").mockImplementation(() => {});
  const options = {
    batch: latest, signal: new AbortController().signal, modelProfileId: "model",
    model: { validateProfile() {}, extract: vi.fn(async () => []), review },
    memory: { learning } as unknown as LongTermMemoryService,
    ownerId: "environment", isCurrent: () => true, timestamp: () => timestamp,
    replace: vi.fn(async (batch: LearningBatch) => { latest = batch; }), failed: vi.fn(),
  };
  return { options, trace, review, embed, repository, latest: () => latest };
}

describe("Co-worker rejection diagnostics", () => {
  it.each([
    ["[]", "learning_output_object_required"],
    ["{}", "learning_output_decisions_missing"],
    ['{"decisions":null}', "learning_output_decisions_not_array"],
    [JSON.stringify({ decisions: Array.from({ length: 13 }, () => ({})) }), "learning_output_decision_limit"],
  ])("preserves the precise envelope rejection without saving or retrying: %s", async (output, reason) => {
    const f = fixture();
    f.review.mockImplementationOnce(async () => parseLearningReviewOutput(output, "batch"));
    await processLearningBatch(f.options);
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.latest()).toMatchObject({ status: "failed", reason, recordIds: [] });
    expect(f.trace).toHaveBeenCalledWith("runtime.passive_learning", "review.output_rejected",
      expect.objectContaining({ batchId: "batch", reason }));
    expect(f.trace).toHaveBeenCalledWith("runtime.passive_learning", "batch.failed",
      expect.objectContaining({ batchId: "batch", reason }));
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.repository.read()).learningReceipts ?? []).toEqual([]);
  });

  it.each([
    "request_context_final_envelope_exceeds_window",
    "request_context_required_content_exceeds_budget",
    "learning_review_context_exceeds_budget",
  ])("keeps only the exact capacity diagnostic: %s", reason => {
    expect(learningFailureReason(new Error(reason))).toBe(reason);
    expect(learningFailureReason(new Error(`${reason}: private captured text`))).toBe("learning_failed");
    expect(learningFailureReason(new Error(`${reason}_unknown`))).toBe("learning_failed");
  });

  it.each<[Partial<LearningMemoryDecision>, string]>([
    [{ observationIds: ["unknown-observation"] }, "learning_decision_source_unknown"],
    [{ action: "update", targetId: "missing", targetVersion: "1" }, "learning_decision_target_unknown"],
    [{ targetKind: "memory" }, "learning_create_target_invalid"],
    [{ targetId: "invented" }, "learning_create_target_invalid"],
    [{ targetVersion: "1" }, "learning_create_target_invalid"],
    [{ reconsiderAt: "2026-09-24T12:00:00.000Z" }, "learning_reconsideration_not_future"],
    [{ mergedCandidateIds: ["unbound"] }, "learning_merge_binding_invalid"],
    [{ score: 101 }, "learning_score_invalid"],
    [{ content: "x".repeat(4001) }, "learning_content_exceeds_limit"],
  ])("preserves a real decision rejection through the batch and event: %j", async (changes, reason) => {
    const f = fixture(changes);
    await processLearningBatch(f.options);
    expect(f.latest()).toMatchObject({ status: "failed", reason, recordIds: [] });
    expect(summarizeBatch(f.latest())).toMatchObject({ status: "failed", reason, observationCount: 1 });
    expect(f.options.failed).toHaveBeenCalledWith(new Error(reason));
    expect(f.trace).toHaveBeenCalledWith("runtime.passive_learning", "batch.failed", {
      batchId: "batch", status: "failed", reason,
    });
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.repository.read()).learningReceipts ?? []).toEqual([]);
  });

  it("keeps an arbitrary model error out of persisted reasons and diagnostics", async () => {
    const f = fixture();
    f.review.mockRejectedValueOnce(new Error("learning_decision_source_unknown: private screen text /workspace/private/file"));
    await processLearningBatch(f.options);
    expect(f.latest().reason).toBe("learning_failed");
    expect(f.trace).toHaveBeenCalledWith("runtime.passive_learning", "batch.failed", {
      batchId: "batch", status: "failed", reason: "learning_failed",
    });
    expect(JSON.stringify(f.trace.mock.calls)).not.toContain("private screen text");
    expect(JSON.stringify(f.trace.mock.calls)).not.toContain("/workspace/private/file");
  });

  it.each([
    new SyntaxError("Unexpected token in private model output"),
    new Error("long_term_memory_embedding_response_invalid: private response body"),
    new Error("bridge_embedding_failed:500:private response body"),
    new Error("learning_unrecognized_future_code"),
    "learning_decision_source_unknown",
  ])("does not pass through unrecognized errors or content-bearing variants", (error) => {
    expect(learningFailureReason(error)).toBe("learning_failed");
  });
});
