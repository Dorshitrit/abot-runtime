import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type { ApplyLearningDecisionsInput } from "../long-term-memory/maturation/contracts.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";
import { createLearningMemoryService } from "../long-term-memory/maturation/service.js";
import * as logger from "../observability/debug-logger.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  let time = Date.parse("2026-09-25T12:00:00.000Z");
  const base = createInMemoryLongTermMemoryRepository();
  const repository = { read: vi.fn(base.read), update: vi.fn(base.update) };
  const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
    modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
  }));
  const learning = createLearningMemoryService({ repository, embeddings: { embed }, now: () => new Date(time) });
  const controller = new AbortController();
  const input: ApplyLearningDecisionsInput = {
    batchId: "runtime-batch", batchExpiresAt: new Date(time + 60_000).toISOString(), environmentId: "dev",
    observations: [{ id: "private-observation", deviceId: "private-device", timestamp: new Date(time).toISOString() }],
    abortSignal: controller.signal, policy: DEFAULT_MATURATION_POLICY,
    context: { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 0,
      knowledgeRevision: 0, entries: [], omitted: 0, referenceTime: new Date(time).toISOString() },
    decisions: [{ action: "create", targetKind: "candidate", targetId: null, targetVersion: null,
      content: "Private screen-derived insight", tags: ["private-tag"], score: 45, reason: "Private explanation",
      certainty: "observed", reinforced: true, observationIds: ["private-observation"], mergedCandidateIds: [], reconsiderAt: null }],
  };
  const trace = vi.spyOn(logger, "traceDebug").mockImplementation(() => {});
  const event = () => {
    expect(trace).toHaveBeenCalledOnce();
    const [scope, name, data] = trace.mock.calls[0]!;
    expect(scope).toBe("runtime.long_term_memory");
    expect(data).toMatchObject({ requestId: "learning:runtime-batch", batchId: "runtime-batch" });
    expect(JSON.stringify(data)).not.toMatch(/Private|private-/);
    return { name, data };
  };
  return { repository, embed, learning, controller, input, trace, event, advance: () => { time += 30_000; } };
}

describe("learning memory apply diagnostics", () => {
  it("emits one content-free commit outcome with counts and bounded stage timings", async () => {
    const f = fixture();
    const receipt = await f.learning.apply(f.input);
    const { name, data } = f.event();
    expect(name).toBe("learning.apply_completed");
    expect(data).toMatchObject({ mode: "observations", stage: "commit", status: "completed", decisionCount: 1,
      observationCount: 1, knowledgeEntryCount: 0, embeddingCount: 1, receiptReused: false,
      recordCount: 0, candidateCount: 1, removedCandidateCount: 0 });
    expect(data!.stageDurationMs).toEqual({ validation: expect.any(Number), admission: expect.any(Number),
      binding: expect.any(Number), embedding: expect.any(Number), commit: expect.any(Number) });
    for (const duration of Object.values(data!.stageDurationMs as Record<string, number>)) {
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(duration).toBeLessThanOrEqual(data!.durationMs as number);
    }
    expect(JSON.stringify(data)).not.toContain(receipt.candidateIds[0]);
    expect(await f.learning.receipt(f.input.batchId)).toEqual(receipt);
  });

  it.each(["admission", "embedding", "commit"] as const)("preserves the original %s error without logging its body or retrying", async (stage) => {
    const f = fixture();
    const error = new Error("Private provider response /private-file");
    if (stage === "admission") f.repository.read.mockRejectedValueOnce(error);
    if (stage === "embedding") f.embed.mockRejectedValueOnce(error);
    if (stage === "commit") f.repository.update.mockRejectedValueOnce(error);
    await expect(f.learning.apply(f.input)).rejects.toBe(error);
    expect(f.event()).toMatchObject({ name: "learning.apply_failed", data: { stage, status: "failed", errorType: "error" } });
    expect(f.repository.read).toHaveBeenCalledOnce();
    expect(f.embed).toHaveBeenCalledTimes(stage === "admission" ? 0 : 1);
    expect(f.repository.update).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
  });

  it("identifies a rejected source binding before embedding or writes", async () => {
    const f = fixture();
    const input = { ...f.input, decisions: [{ ...f.input.decisions[0]!, observationIds: ["private-invented-source"] }] };
    await expect(f.learning.apply(input)).rejects.toThrow("learning_decision_source_unknown");
    expect(f.event().data).toMatchObject({ stage: "binding", embeddingCount: 0, errorType: "error" });
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.repository.update).not.toHaveBeenCalled();
  });

  it("identifies initial decision validation before reading the repository", async () => {
    const f = fixture();
    await expect(f.learning.apply({ ...f.input, decisions: [{ ...f.input.decisions[0]!, score: 101 }] })).rejects.toThrow("learning_score_invalid");
    expect(f.event().data).toMatchObject({ stage: "validation", status: "failed" });
    expect(f.repository.read).not.toHaveBeenCalled();
  });

  it("preserves cancellation and does not emit the abort reason", async () => {
    const f = fixture();
    const reason = { private: "Private cancellation" };
    f.controller.abort(reason);
    await expect(f.learning.apply(f.input)).rejects.toBe(reason);
    expect(f.event().data).toMatchObject({ stage: "validation", status: "cancelled", errorType: "abort" });
    expect(f.repository.read).not.toHaveBeenCalled();
  });

  it("reports receipt replay without embedding or committing again", async () => {
    const f = fixture();
    const original = await f.learning.apply(f.input);
    f.trace.mockClear(); f.embed.mockClear(); f.repository.update.mockClear();
    expect(await f.learning.apply(f.input)).toEqual(original);
    expect(f.event().data).toMatchObject({ stage: "admission", receiptReused: true, embeddingCount: 0, candidateCount: 1 });
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.repository.update).not.toHaveBeenCalled();
  });

  it("recognizes a receipt committed by a concurrent application of the same batch", async () => {
    const f = fixture();
    const receipts = await Promise.all([f.learning.apply(f.input), f.learning.apply(f.input)]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(f.trace).toHaveBeenCalledTimes(2);
    expect(f.trace.mock.calls.map(([, , data]) => data!.receiptReused).sort()).toEqual([false, true]);
    expect((await f.repository.read()).learningCandidates).toHaveLength(1);
  });

  it("covers a scheduled no-change review with no synthetic observations or embedding", async () => {
    const f = fixture();
    await f.learning.apply({ ...f.input, batchId: "seed", decisions: [{ ...f.input.decisions[0]!, reconsiderAt: "2026-09-25T12:00:30.000Z" }] });
    f.advance();
    const context = await f.learning.reconsiderationContext();
    f.trace.mockClear(); f.embed.mockClear();
    await f.learning.apply({ ...f.input, observations: [], decisions: [], context,
      cause: { kind: "scheduled_knowledge_review", dueEntries: context.entries.map(({ kind, id, version }) => ({ kind, id, version })) } });
    expect(f.event().data).toMatchObject({ mode: "scheduled", stage: "commit", status: "completed",
      observationCount: 0, decisionCount: 0, knowledgeEntryCount: 1, embeddingCount: 0 });
    expect(f.embed).not.toHaveBeenCalled();
    expect(await f.learning.nextReconsiderationAt()).toBeNull();
  });
});
