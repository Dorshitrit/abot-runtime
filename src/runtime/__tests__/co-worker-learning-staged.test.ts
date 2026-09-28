import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import { projectOllamaFormat } from "../../model-gateway/structured-output/ollama-format.js";
import { projectOpenAIResponsesFormat } from "../../model-gateway/structured-output/openai-format.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { resolveCoWorkerReviewMethod } from "../passive-learning/review-method.js";
import { reviewLearningBatch } from "../passive-learning/review-batch.js";
import type { LearningBatch } from "../passive-learning/contracts.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { LEARNING_NOW as NOW, learningCandidate as candidate, learningInput as input,
  learningFixture as fixture, learningIdea as idea, learningDraft as draft, learningAssessment as assessment,
  learningTiming as timing, learningOutput as output, enqueueLearningCreation, enqueueLearningUpdate } from "./support/co-worker-learning-fixture.js";

beforeEach(() => { configureDebugLogger({ enabled: false }); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(async () => { vi.useRealTimers(); await disposeCompositionFixtures(); resetDebugLoggerConfig(); });

describe("Co-worker learning methods", () => {
  it("selects by execution policy and keeps EA's original one-call contract", async () => {
    const f = await fixture(true);
    expect(resolveCoWorkerReviewMethod(f.config, "learning")).toBe("direct");
    expect(resolveCoWorkerReviewMethod({ ...f.config, modelExecutionPolicies: {} }, "learning")).toBe("staged");
    const { ref: _ref, ...content } = draft;
    const { ref: _assessmentRef, ...rating } = assessment;
    f.invoke.mockResolvedValueOnce(output([{ action: "create", ...content, ...rating, reconsiderAt: null, evidence: ["o1"] }]));
    await expect(f.model.review!(input())).resolves.toMatchObject([{ action: "create", content: content.content }]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.invoke.mock.calls[0]![0].format).toMatchObject({ name: "learning_review_decisions_v2" });
  });

  it("stops after discovery when no useful idea is found", async () => {
    const f = await fixture();
    f.invoke.mockResolvedValueOnce(output([]));
    await expect(f.model.review!(input())).resolves.toEqual([]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("separates discovery, relationship, change, writing, assessment and timing", async () => {
    const f = await fixture();
    const original = input([candidate, { ...candidate, id: "unrelated", content: "PRIVATE UNRELATED KNOWLEDGE" }]);
    const request = { ...original, observations: [...original.observations, { ...original.observations[0]!,
      id: "unrelated-observation", content: "PRIVATE UNRELATED OBSERVATION" }] };
    enqueueLearningUpdate(f.invoke);
    const decisions = await f.model.review!(request);
    expect(decisions).toMatchObject([{ action: "update", targetId: candidate.id, targetVersion: "3",
      observationIds: ["private-observation"], reinforced: true, certainty: "inferred", score: 95 }]);
    expect(f.invoke.mock.calls.map(([value]) => (value.format as ModelGatewayJsonSchemaFormat).name)).toEqual([
      "learning_discovery_v2", "learning_matching_v2", "learning_change_v2", "learning_authoring_v2",
      "learning_assessment_v2", "learning_timing_v2",
    ]);
    const authoring = f.invoke.mock.calls[3]![0];
    expect((authoring.messages as ChatMessage[]).every(message => message.role === "system")).toBe(true);
    const serialized = JSON.stringify(authoring.messages);
    expect(serialized).not.toContain("PRIVATE UNRELATED");
    expect(serialized).not.toContain("private-candidate");
    expect(serialized).not.toContain("private-observation");
    expect(serialized).toContain(candidate.content);
    for (const [request] of f.invoke.mock.calls) {
      const format = request.format as ModelGatewayJsonSchemaFormat;
      expect(() => projectOllamaFormat(format)).not.toThrow();
      expect(projectOpenAIResponsesFormat(format).format?.schema).toEqual(format.schema);
    }
    expect(JSON.stringify(authoring.format)).not.toContain('"score"');
    expect(JSON.stringify(authoring.format)).not.toContain('"reinforced"');
    expect(JSON.stringify(f.invoke.mock.calls[0]![0].format)).not.toContain('"target"');
  });

  it("creates a candidate first and promotes only on a later independent reinforcement", async () => {
    const f = await fixture();
    const repository = createInMemoryLongTermMemoryRepository();
    let now = NOW;
    const memory = createLongTermMemoryService({ repository, enabled: true, emitClientEvents: false,
      now: () => new Date(now), embeddings: { embed: async ({ texts }) => ({
        modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
      }) } });
    const batch: LearningBatch = { id: "first", status: "pending", createdAt: new Date(NOW).toISOString(),
      generation: "test", recordIds: [], observations: input().observations };
    const review = (value: LearningBatch) => reviewLearningBatch({ batch: value, memory, model: f.model,
      modelProfileId: "learning", signal: new AbortController().signal, ownerId: "test", isCurrent: () => true });
    enqueueLearningCreation(f.invoke, 95);
    const first = await review(batch);
    expect(first.candidateIds).toHaveLength(1);
    expect((await memory.list()).total).toBe(0);
    now += 60_000; vi.setSystemTime(now);
    enqueueLearningUpdate(f.invoke, 96);
    const later = await review({ ...batch, id: "second", createdAt: new Date(now).toISOString(),
      observations: [{ ...batch.observations[0]!, id: "another-observation", sequence: 2,
        timestamp: new Date(now).toISOString(), content: "Researching equipment for a different hiking route." }] });
    expect(later.recordIds).toEqual(first.candidateIds);
    expect(await memory.learning!.list()).toEqual([]);
    expect((await memory.list()).total).toBe(1);
    expect(f.invoke).toHaveBeenCalledTimes(10);
    await memory.retention?.stop();
  });

  it("selects merge sources in their own step and keeps removal small", async () => {
    const f = await fixture();
    for (const row of [idea, { ref: "d1", match: "k1" }, { ref: "d1", change: "combine" },
      { ref: "d1", sources: ["k2"] }, draft, { ...assessment, reinforced: true }, timing])
      f.invoke.mockResolvedValueOnce(output([row]));
    await expect(f.model.review!(input([candidate, { ...candidate, id: "second", version: "7" }]))).resolves.toMatchObject([
      { action: "merge", targetId: candidate.id, targetVersion: "3", mergedCandidateIds: ["second"] },
    ]);
    expect(f.invoke.mock.calls[3]![0].format).toMatchObject({ name: "learning_merge_d1_v2" });
    for (const row of [idea, { ref: "d1", match: "k1" }, { ref: "d1", change: "remove" },
      { ref: "d1", reason: "Evidence retracts the claim." }]) f.invoke.mockResolvedValueOnce(output([row]));
    await expect(f.model.review!(input([candidate]))).resolves.toMatchObject([
      { action: "remove", targetId: candidate.id, content: "", reinforced: false },
    ]);
    expect(f.invoke).toHaveBeenCalledTimes(11);
  });

  it.each([{ evidence: [] }, { evidence: ["o99"] }, { objective: "" }])("rejects invalid discovery before another call: %j", async invalid => {
    const f = await fixture();
    f.invoke.mockResolvedValueOnce(output([{ ...idea, ...invalid }]));
    await expect(f.model.review!(input([candidate]))).rejects.toThrow();
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("prevents protected targets and authoring retargets", async () => {
    const f = await fixture();
    f.invoke.mockResolvedValueOnce(output([idea])).mockResolvedValueOnce(output([{ ref: "d1", match: "k1" }]));
    await expect(f.model.review!(input([{ ...candidate, mutable: false }]))).rejects.toThrow("learning_review_output_contract_invalid");
    f.invoke.mockResolvedValueOnce(output([idea])).mockResolvedValueOnce(output([{ ...draft, ref: "d99" }]));
    await expect(f.model.review!(input())).rejects.toThrow("learning_review_output_contract_invalid");
    expect(f.invoke).toHaveBeenCalledTimes(4);
  });

  it("keeps scheduled review restricted to due entries without discovery or reinforcement", async () => {
    const f = await fixture();
    for (const row of [{ ref: "d1", change: "revise" }, draft, { ...assessment, score: 35 }, timing])
      f.invoke.mockResolvedValueOnce(output([row]));
    const request = input([candidate, { ...candidate, id: "not-due" }]);
    const result = await f.model.review!({ ...request, observations: [], cause: {
      kind: "scheduled_knowledge_review", dueEntries: [{ kind: "candidate", id: candidate.id, version: candidate.version }],
    } });
    expect(result).toMatchObject([{ action: "update", score: 35, observationIds: [], reinforced: false }]);
    expect(f.invoke).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(f.invoke.mock.calls[2]![0].format)).not.toContain('"reinforced"');
  });

  it("does not start another stage after cancellation", async () => {
    const f = await fixture();
    const abort = new AbortController();
    f.invoke.mockImplementationOnce(async () => { abort.abort(new Error("learning_processing_paused")); return output([idea]); });
    await expect(f.model.review!({ ...input(), signal: abort.signal })).rejects.toThrow("learning_processing_paused");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not return partial decisions or add repair calls on invalid authoring", async () => {
    const f = await fixture();
    f.invoke.mockResolvedValueOnce(output([idea])).mockResolvedValueOnce({ text: "unreadable", meta: {} });
    await expect(f.model.review!(input())).rejects.toThrow("learning_output_invalid_json");
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
});
