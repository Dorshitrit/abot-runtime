import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningKnowledgeContext, LearningMemoryReceipt } from "../long-term-memory/maturation/contracts.js";
import type { LearningBatch } from "../passive-learning/contracts.js";
import { createRuntimePassiveLearningModel } from "../passive-learning/model.js";
import { processLearningBatch } from "../passive-learning/process-batch.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import { learningBatchExpiresAt } from "../passive-learning/batch-lifecycle.js";
import { partitionOversizedLearningBatch } from "../passive-learning/batch-partition.js";
import { LearningReviewCapacityError } from "../passive-learning/review-capacity.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

afterEach(disposeCompositionFixtures);
const timestamp = "2026-09-25T12:00:00.000Z";
const context: LearningKnowledgeContext = {
  kind: "learning_knowledge_reference_v1", authority: "passive_reference",
  presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 0,
  knowledgeRevision: 0, referenceTime: timestamp, entries: [], omitted: 0,
};

async function fixture() {
  const base = await createRuntimeConfig();
  await writeFile(base.requestRunner.configPath, JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "learning", steps: {} } }, context: {
      outputReserveTokens: 200, safetyReserveTokens: 50, attachmentReserveTokens: 1,
    }, stepDefaults: { timeoutMs: 5000 }, steps: {},
  }));
  const config = { ...base, modelExecutionPolicies: { learning: { policy: "execution-agent-v1" as const } },
    models: { defaults: { profileId: "learning" },
    providers: { cloud: { type: "openai" } }, profiles: {
      learning: { provider: "cloud", model: "scripted", contextWindowTokens: 1000 },
    } } };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({ text: '{"decisions":[]}', meta: {} }));
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async ({ messages }) => ({
    inputTokens: JSON.parse((messages as ChatMessage[])[3]!.content).observations.length > 1 ? 800 : 600,
    profileId: "learning", provider: "openai", model: "scripted", contextWindowTokens: 1000,
    source: "provider_input_token_count",
  }));
  const model = createRuntimePassiveLearningModel({ config, models: { invoke, invokeRaw: vi.fn(), countInputTokens } });
  const batch: LearningBatch = { id: "batch", createdAt: timestamp, generation: "generation",
    status: "pending", recordIds: [], observations: ["first", "second"].map((id, index) => ({
      id, deviceId: "computer", sequence: index + 1, timestamp, source: { app: "editor", windowId: "1" },
      content: `The entire ${id} observation`, kind: "view", extraction: "uia", coverage: "partial",
    })),
  };
  const store = createLearningStateStore(base.paths.runtimeDir);
  const history = new Map<string, LearningBatch>();
  const partition = vi.fn(async (batches: readonly LearningBatch[]) => {
    for (const value of batches) history.set(value.id, value);
    await store.write({ schemaVersion: 1, preferences: DEFAULT_LEARNING_PREFERENCES, batches: [...history.values()] });
    return true;
  });
  const replace = vi.fn(async (value: LearningBatch) => {
    history.set(value.id, value);
    await store.write({ schemaVersion: 1, preferences: DEFAULT_LEARNING_PREFERENCES, batches: [...history.values()] });
  });
  let revision = 0;
  const receipts = new Map<string, LearningMemoryReceipt>();
  const prepare = vi.fn(async () => ({ ...context, repositoryRevision: revision, knowledgeRevision: revision }));
  const apply = vi.fn(async (input: { batchId: string }) => {
    const receipt: LearningMemoryReceipt = { batchId: input.batchId, recordIds: [], candidateIds: [],
      removedCandidateCount: 0, createdAt: timestamp, expiresAt: "2026-09-26T12:00:00.000Z" };
    receipts.set(input.batchId, receipt); revision += 1; return receipt;
  });
  const memory = { learning: { prepare, apply, policy: async () => DEFAULT_MATURATION_POLICY,
    receipt: async (id: string) => receipts.get(id) } } as unknown as LongTermMemoryService;
  const abort = new AbortController();
  const options = { batch, model, memory, modelProfileId: "learning", signal: abort.signal,
    ownerId: "dev", isCurrent: () => true, timestamp: () => timestamp, replace, partition, failed: vi.fn() };
  return { options, invoke, countInputTokens, store, history, prepare, apply, abort };
}

describe("learning review context capacity", () => {
  test("persists complete smaller pending batches before any model call and reviews each against fresh knowledge", async () => {
    const f = await fixture();
    await processLearningBatch(f.options);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.options.failed).not.toHaveBeenCalled();
    const saved = (await f.store.read()).batches;
    expect(saved).toHaveLength(2);
    expect(saved.every(batch => batch.status === "pending" && batch.reason === "learning_batch_partitioned")).toBe(true);
    expect(saved.flatMap(batch => batch.observations)).toEqual(f.options.batch.observations);
    expect(saved[0]!.id).toBe(f.options.batch.id);
    expect(saved[1]!.id).not.toBe(saved[0]!.id);
    expect(saved.map(learningBatchExpiresAt)).toEqual(saved.map(() => learningBatchExpiresAt(f.options.batch)));
    for (const batch of saved) await processLearningBatch({ ...f.options, batch });
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.apply).toHaveBeenCalledTimes(2);
    const calls = f.invoke.mock.calls.map(([input]) => {
      const messages = input.messages as ChatMessage[];
      expect(messages.every(message => message.role === "system")).toBe(true);
      return { knowledge: JSON.parse(messages[2]!.content), evidence: JSON.parse(messages[3]!.content) };
    });
    expect(calls.map(call => call.knowledge.repositoryRevision)).toEqual([0, 1]);
    expect(calls.flatMap(call => call.evidence.observations).map(({ content }: { content: string }) => content))
      .toEqual(f.options.batch.observations.map(({ content }) => content));
    expect(calls.flatMap(call => call.evidence.observations).every(({ ref }: { ref: string }) => ref === "o1")).toBe(true);
    expect((await f.store.read()).batches.every(batch => batch.status === "discarded")).toBe(true);
  });

  test("one invocation translates a compact model decision back to the actual whole observation", async () => {
    const f = await fixture();
    const observations = f.options.batch.observations.slice(1);
    f.invoke.mockResolvedValueOnce({ text: JSON.stringify({ decisions: [{ action: "create",
      content: "Prefers focused summaries", tags: [], score: 45, reason: "A recurring preference",
      certainty: "inferred", reconsiderAt: null, evidence: ["o1"] }] }), meta: {} });
    await processLearningBatch({ ...f.options, batch: { ...f.options.batch, observations } });
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.apply).toHaveBeenCalledWith(expect.objectContaining({
      observations, context, decisions: [expect.objectContaining({
        action: "create", targetKind: "candidate", targetId: null, targetVersion: null,
        observationIds: ["second"], mergedCandidateIds: [], reinforced: false,
      })],
    }));
    expect(f.options.failed).not.toHaveBeenCalled();
  });

  test("reports a single oversized observation without dispatch or partition", async () => {
    const f = await fixture();
    f.options.batch = { ...f.options.batch, observations: f.options.batch.observations.slice(0, 1) };
    f.countInputTokens.mockResolvedValue({ inputTokens: 800, profileId: "learning", provider: "openai",
      model: "scripted", contextWindowTokens: 1000, source: "provider_input_token_count" });
    await processLearningBatch(f.options);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.options.partition).not.toHaveBeenCalled();
    expect(f.history.get("batch")).toMatchObject({ status: "failed", reason: "learning_review_context_exceeds_budget" });
  });

  test("does not partition provider failures, cancellation or superseded work", async () => {
    const f = await fixture();
    expect(await partitionOversizedLearningBatch(new Error("provider_unavailable"), f.options)).toBe(false);
    expect(await partitionOversizedLearningBatch(new LearningReviewCapacityError(), { ...f.options, isCurrent: () => false })).toBe(false);
    f.abort.abort(new Error("learning_stopped"));
    expect(await partitionOversizedLearningBatch(new LearningReviewCapacityError(), f.options)).toBe(false);
    expect(f.options.partition).not.toHaveBeenCalled();
  });

  test("surfaces a partition write failure without overwriting its staged pending records", async () => {
    const f = await fixture();
    f.options.partition.mockRejectedValueOnce(new Error("learning_storage_unavailable"));
    await processLearningBatch(f.options);
    expect(f.options.failed).toHaveBeenCalledWith(new Error("learning_storage_unavailable"));
    expect(f.options.replace).toHaveBeenCalledOnce();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  test("keeps the original pending if the bounded journal cannot safely hold both parts", async () => {
    const f = await fixture();
    f.options.partition.mockResolvedValueOnce(false);
    await processLearningBatch(f.options);
    expect(f.options.failed).toHaveBeenCalledWith(new Error("learning_partition_capacity"));
    expect((await f.store.read()).batches).toEqual([f.options.batch]);
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
