import { describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type { LongTermMemoryRepositorySnapshot, MemoryVectorIndexEntry } from "../long-term-memory/contracts.js";
import type { ApplyLearningDecisionsInput, LearningCandidateRecord } from "../long-term-memory/maturation/contracts.js";
import { assertLearningEmbeddingCapacity, DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";
import { createLearningMemoryService } from "../long-term-memory/maturation/service.js";
import { searchRankedLongTermMemories } from "../long-term-memory/ranked-search.js";
import { ensureCurrentVectorIndex } from "../long-term-memory/vector-index.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const currentBinding = { modelFingerprint: "openai-current", dimensions: 3 };
function vector(memoryId: string, current = false): MemoryVectorIndexEntry {
  return { memoryId, modelFingerprint: current ? currentBinding.modelFingerprint : "ollama-old",
    dimensions: current ? 3 : 2, vector: current ? [1, 0, 0] : [1, 0] };
}
function candidate(id = "candidate", current = false): LearningCandidateRecord {
  return { id, revision: 3, content: `Useful knowledge ${id}`, tags: ["preference"], score: 55,
    reason: "Repeated evidence", certainty: "observed", createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 30_000).toISOString(), lastReinforcedAt: new Date(NOW - 30_000).toISOString(),
    expiresAt: new Date(NOW - 30_000 + 30 * 86_400_000).toISOString(), reconsiderAt: new Date(NOW - 1).toISOString(),
    sources: [{ kind: "passive_response", sourceSessionId: "session", sourceRequestId: "request", observedAt: new Date(NOW - 30_000).toISOString(),
      evidenceDigest: "a".repeat(64), reason: "Repeated evidence", certainty: "observed" }],
    reinforcements: [{ key: "b".repeat(64), observedAt: new Date(NOW - 30_000).toISOString() }],
    replacement: { id: "memory", version: new Date(NOW - 60_000).toISOString() }, embedding: vector(id, current) };
}
function snapshot(options: { memory?: boolean; currentMemory?: boolean; currentCandidate?: boolean } = {}): LongTermMemoryRepositorySnapshot {
  const records = options.memory ? [{ id: "memory", content: "Existing stored knowledge", tags: ["fact"],
    createdAt: new Date(NOW - 60_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(),
    provenance: { kind: "manual" as const, source: "web_ui" as const }, automaticManagement: "protected" as const }] : [];
  return { schemaVersion: 5, revision: 9, knowledgeRevision: 4, records,
    vectors: records.map(({ id }) => vector(id, options.currentMemory)), learningCandidates: [candidate("candidate", options.currentCandidate)] };
}
function fixture(initial = snapshot()) {
  let time = NOW;
  const base = createInMemoryLongTermMemoryRepository(initial);
  const repository = { read: base.read, update: vi.fn(base.update) };
  const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({ ...currentBinding, vectors: texts.map(() => [1, 0, 0]) }));
  const embeddings = { embed, maxBatchSize: 2 };
  const learning = createLearningMemoryService({ repository, embeddings, now: () => new Date(time) });
  const abort = new AbortController();
  const prepare = (beforeEmbedding?: ApplyLearningDecisionsInput["beforeEmbedding"]) => learning.prepare({ query: "Useful knowledge", abortSignal: abort.signal, ...(beforeEmbedding ? { beforeEmbedding } : {}) });
  const reindex = () => ensureCurrentVectorIndex({ repository, embeddings, snapshot: initial, ...currentBinding,
    now: () => time, context: { abortSignal: abort.signal } });
  const applyInput = async (): Promise<ApplyLearningDecisionsInput> => {
    const context = await learning.reconsiderationContext();
    return { batchId: "review", batchExpiresAt: new Date(time + 60_000).toISOString(), environmentId: "dev", observations: [],
      abortSignal: abort.signal, policy: DEFAULT_MATURATION_POLICY, context, decisions: [],
      cause: { kind: "scheduled_knowledge_review", dueEntries: context.entries.map(({ kind, id, version }) => ({ kind, id, version })) } };
  };
  return { initial, repository, embed, embeddings, learning, abort, prepare, reindex, applyInput, advance: (ms: number) => { time += ms; } };
}
function withoutEmbedding(record: LearningCandidateRecord) {
  const { embedding: _embedding, ...semantic } = record;
  return semantic;
}

describe("learning memory embedding index migration", () => {
  it.each([{ memory: true }, { memory: true, currentMemory: true }, {}])("prepares a coherent model and dimension index for %j", async (options) => {
    const f = fixture(snapshot(options));
    const before = await f.repository.read();
    const context = await f.prepare();
    const after = await f.repository.read();
    expect(after.learningCandidates![0]!.embedding).toEqual(vector("candidate", true));
    expect(after.vectors).toEqual(after.records.map(({ id }) => vector(id, true)));
    expect(after.records).toEqual(before.records);
    expect(withoutEmbedding(after.learningCandidates![0]!)).toEqual(withoutEmbedding(before.learningCandidates![0]!));
    expect(after.knowledgeRevision).toBe(before.knowledgeRevision);
    expect(after.revision).toBe(before.revision + 1);
    expect(context.repositoryRevision).toBe(after.revision);
    expect(context.knowledgeRevision).toBe(before.knowledgeRevision);
    expect(context.entries.map(({ id }) => id).sort()).toEqual(options.memory ? ["candidate", "memory"] : ["candidate"]);
    expect(f.embed.mock.calls.every(([input]) => input.texts.length <= 2)).toBe(true);
  });

  it("leaves compatible indexes unchanged and spends only the existing query embedding", async () => {
    const f = fixture(snapshot({ memory: true, currentMemory: true, currentCandidate: true }));
    await f.prepare();
    expect(f.embed).toHaveBeenCalledOnce();
    expect(f.repository.update).not.toHaveBeenCalled();
    expect(await f.repository.read()).toEqual(f.initial);
  });

  it("reindexes learning candidates when ordinary retrieval refreshes stored memory", async () => {
    const f = fixture(snapshot({ memory: true }));
    await searchRankedLongTermMemories({ repository: f.repository, embeddings: f.embeddings, query: "knowledge", context: { abortSignal: f.abort.signal } });
    expect((await f.repository.read()).learningCandidates![0]!.embedding).toEqual(vector("candidate", true));
  });

  it("prepares and applies a review after migration without treating index work as evidence", async () => {
    const f = fixture(snapshot({ memory: true, currentMemory: true }));
    const prepared = await f.prepare();
    const input = await f.applyInput();
    const receipt = await f.learning.apply({ ...input, context: prepared });
    const after = await f.repository.read();
    expect(receipt.batchId).toBe(input.batchId);
    expect(after.learningCandidates![0]).toMatchObject({ score: 55, expiresAt: f.initial.learningCandidates![0]!.expiresAt,
      lastReinforcedAt: f.initial.learningCandidates![0]!.lastReinforcedAt, reinforcements: f.initial.learningCandidates![0]!.reinforcements });
    expect(after.learningCandidates![0]!.reconsiderAt).toBeNull();
  });

  it("repairs mixed indexes for direct scheduled apply without prior prepare", async () => {
    const f = fixture(snapshot({ memory: true, currentMemory: true }));
    const input = await f.applyInput();
    const release = vi.fn();
    const reserve = vi.fn(async () => release);
    await f.learning.apply({ ...input, beforeEmbedding: reserve });
    expect((await f.repository.read()).learningCandidates![0]!.embedding).toEqual(vector("candidate", true));
    expect(f.embed).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    f.embed.mockClear();
    await f.learning.apply(input);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("uses the actual changed-content binding for direct apply on a coherent old index", async () => {
    const f = fixture();
    const input = await f.applyInput();
    const target = input.context.entries[0]!;
    await f.learning.apply({ ...input, decisions: [{ action: "update", targetKind: "candidate", targetId: target.id, targetVersion: target.version,
      content: "Updated useful knowledge", tags: target.tags, score: 55, reason: "Reassessment", certainty: "observed", reinforced: false,
      observationIds: [], mergedCandidateIds: [], reconsiderAt: null }] });
    expect((await f.repository.read()).learningCandidates![0]).toMatchObject({ content: "Updated useful knowledge", embedding: vector("candidate", true),
      lastReinforcedAt: f.initial.learningCandidates![0]!.lastReinforcedAt, expiresAt: f.initial.learningCandidates![0]!.expiresAt });
  });

  it("preserves lazy regular-memory indexes for coherent unchanged direct apply", async () => {
    const f = fixture({ ...snapshot({ memory: true, currentCandidate: true }), vectors: [] });
    await f.learning.apply(await f.applyInput());
    expect((await f.repository.read()).vectors).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("does not embed a coherent unchanged scheduled apply", async () => {
    const f = fixture();
    await f.learning.apply(await f.applyInput());
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("reserves every query/index batch and releases reservations on failure", async () => {
    const f = fixture(snapshot({ memory: true }));
    f.embed.mockRejectedValueOnce(new Error("provider unavailable"));
    const release = vi.fn();
    const reserve = vi.fn(async () => release);
    await expect(f.prepare(reserve)).rejects.toThrow("provider unavailable");
    expect(reserve).toHaveBeenCalledWith({ characters: "Useful knowledge".length, signal: f.abort.signal });
    expect(release).toHaveBeenCalledOnce();
    expect(await f.repository.read()).toEqual(f.initial);
  });

  it.each(["failure", "abort", "binding change"])("does not persist partial reindex on %s", async (mode) => {
    const initial = { ...snapshot({ memory: true }), learningCandidates: [candidate(), candidate("second")] };
    const f = fixture(initial);
    f.embed.mockImplementation(async ({ texts }) => {
      if (f.embed.mock.calls.length === 2) {
        if (mode === "failure") throw new Error("provider unavailable");
        if (mode === "abort") f.abort.abort(new Error("cancelled"));
        if (mode === "binding change") return { modelFingerprint: "third", dimensions: 3, vectors: texts.map(() => [1, 0, 0]) };
      }
      return { ...currentBinding, vectors: texts.map(() => [1, 0, 0]) };
    });
    await expect(f.reindex()).rejects.toThrow();
    expect(f.repository.update).not.toHaveBeenCalled();
    expect(await f.repository.read()).toEqual(initial);
  });

  it("checks abort again inside the repository transaction", async () => {
    const f = fixture();
    const original = f.repository.update.getMockImplementation()!;
    f.repository.update.mockImplementation(async (mutate) => {
      f.abort.abort(new Error("cancel before commit"));
      return original(mutate);
    });
    await expect(f.reindex()).rejects.toThrow("cancel before commit");
    expect(await f.repository.read()).toEqual(f.initial);
  });

  it.each(["edit", "delete", "newer index", "expiry"])("preserves concurrent candidate %s during asynchronous embedding", async (mode) => {
    const f = fixture();
    let expected: readonly LearningCandidateRecord[] | undefined;
    f.embed.mockImplementationOnce(async ({ texts }) => {
      if (mode === "expiry") f.advance(30 * 86_400_000);
      else await f.repository.update((state) => ({ ...state, learningCandidates: mode === "delete" ? [] : state.learningCandidates!.map((record) =>
        mode === "edit" ? { ...record, revision: record.revision + 1, content: "Concurrent change", score: 75 }
          : { ...record, embedding: { ...vector(record.id, true), modelFingerprint: "newer-model" } }) }));
      expected = (await f.repository.read()).learningCandidates;
      return { ...currentBinding, vectors: texts.map(() => [1, 0, 0]) };
    });
    await f.reindex();
    expect((await f.repository.read()).learningCandidates).toEqual(expected);
  });

  it("keeps newly created candidates and rejects a mixed race before preparing model context", async () => {
    const f = fixture();
    f.embed.mockImplementation(async ({ texts }) => {
      if (f.embed.mock.calls.length === 2) await f.repository.update((state) => ({ ...state,
        learningCandidates: [...state.learningCandidates!, candidate("concurrent")] }));
      return { ...currentBinding, vectors: texts.map(() => [1, 0, 0]) };
    });
    await expect(f.prepare()).rejects.toThrow("learning_embedding_reindex_required");
    expect((await f.repository.read()).learningCandidates!.map(({ id }) => id)).toEqual(["candidate", "concurrent"]);
    expect((await f.repository.read()).learningCandidates![1]).toEqual(candidate("concurrent"));
  });

  it("retains a newer regular-memory index even when its content did not change", async () => {
    const f = fixture(snapshot({ memory: true }));
    const newer = { ...vector("memory", true), modelFingerprint: "newer-model" };
    f.embed.mockImplementationOnce(async ({ texts }) => {
      await f.repository.update((state) => ({ ...state, vectors: [newer] }));
      return { ...currentBinding, vectors: texts.map(() => [1, 0, 0]) };
    });
    await f.reindex();
    expect((await f.repository.read()).vectors).toEqual([newer]);
  });

  it("stops a migration when its index embedding reservation is denied", async () => {
    const f = fixture();
    const release = vi.fn();
    const reserve = vi.fn(async () => release).mockResolvedValueOnce(release).mockRejectedValueOnce(new Error("budget exhausted"));
    await expect(f.prepare(reserve)).rejects.toThrow("budget exhausted");
    expect(f.embed).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(f.repository.update).not.toHaveBeenCalled();
    expect(await f.repository.read()).toEqual(f.initial);
  });

  it("does not apply stale decisions if a target changes during reindexing", async () => {
    const f = fixture(snapshot({ memory: true, currentMemory: true }));
    const input = await f.applyInput();
    f.embed.mockImplementation(async ({ texts }) => {
      if (f.embed.mock.calls.length === 2) await f.repository.update((state) => ({ ...state,
        learningCandidates: state.learningCandidates!.map((record) => ({ ...record, revision: record.revision + 1,
          content: "Newer content", embedding: vector(record.id, true) })) }));
      return { ...currentBinding, vectors: texts.map(() => [1, 0, 0]) };
    });
    await expect(f.learning.apply(input)).rejects.toThrow("learning_knowledge_conflict");
    expect((await f.repository.read()).learningCandidates![0]!.content).toBe("Newer content");
    expect(await f.learning.receipt(input.batchId)).toBeUndefined();
  });

  it("keeps empty-query preparation read-only without embedding", async () => {
    const f = fixture();
    expect((await f.learning.prepare({ query: " ", abortSignal: f.abort.signal })).entries).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
    expect(f.repository.update).not.toHaveBeenCalled();
  });

  it("rejects vector growth beyond the canonical live-byte limit without partial writes", async () => {
    const { sources: _sources, reinforcements: _proofs, replacement: _replacement, ...content } = candidate();
    const compact = { ...content, sources: [] };
    const initial = { ...snapshot({ memory: true }), learningCandidates: [compact], maturationPolicy: { ...DEFAULT_MATURATION_POLICY, maxBytes: 1024 } };
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8") + 3).toBeLessThanOrEqual(1024);
    const f = fixture(initial);
    const embeddings = { embed: async ({ texts }: { texts: readonly string[] }) => ({ modelFingerprint: "larger", dimensions: 1536,
      vectors: texts.map(() => Array(1536).fill(0.1) as number[]) }) };
    await expect(ensureCurrentVectorIndex({ repository: f.repository, embeddings, snapshot: initial,
      modelFingerprint: "larger", dimensions: 1536, now: () => NOW, context: { abortSignal: f.abort.signal } }))
      .rejects.toThrow("learning_embedding_capacity_exceeded");
    expect(await f.repository.read()).toEqual(initial);
  });

  it("uses the policy current at the index commit when capacity changes concurrently", async () => {
    const f = fixture();
    let canonical = f.initial;
    f.embed.mockImplementationOnce(async ({ texts }) => {
      canonical = await f.repository.update((state) => ({ ...state, maturationPolicy: { ...DEFAULT_MATURATION_POLICY, maxBytes: 1024 } }));
      return { ...currentBinding, vectors: texts.map(() => [0.12345678912345678, 0.12345678912345678, 0.12345678912345678]) };
    });
    // Make the new vector exceed a cap that was tightened after the embedding started.
    const oversized = candidate();
    const initial = { ...f.initial, learningCandidates: [{ ...oversized, reason: "x".repeat(700) }] };
    await f.repository.update(() => initial);
    await expect(ensureCurrentVectorIndex({ repository: f.repository, embeddings: f.embeddings, snapshot: initial,
      ...currentBinding, now: () => NOW, context: { abortSignal: f.abort.signal } })).rejects.toThrow("learning_embedding_capacity_exceeded");
    expect(await f.repository.read()).toEqual(canonical);
  });

  it("permits shrinking or unchanged indexes already above capacity", async () => {
    const original = { ...candidate(), embedding: { memoryId: "candidate", modelFingerprint: "large-old", dimensions: 1536,
      vector: Array(1536).fill(0.1) as number[] }, reason: "x".repeat(1100) };
    const initial = { ...snapshot(), learningCandidates: [original], maturationPolicy: { ...DEFAULT_MATURATION_POLICY, maxBytes: 1024 } };
    const f = fixture(initial);
    await f.reindex();
    expect((await f.repository.read()).learningCandidates![0]).toEqual({ ...original, embedding: vector("candidate", true) });
    expect(() => assertLearningEmbeddingCapacity([original], [original], initial.maturationPolicy, NOW)).not.toThrow();
  });

  it("excludes policy-expired candidates from capacity accounting without deleting them", () => {
    const original = candidate();
    const updated = { ...original, embedding: { memoryId: original.id, modelFingerprint: "large", dimensions: 1536, vector: Array(1536).fill(0.1) as number[] } };
    const policy = { ...DEFAULT_MATURATION_POLICY, retentionDays: 1, maxBytes: 1024 };
    expect(() => assertLearningEmbeddingCapacity([original], [updated], policy, NOW + 86_400_000)).not.toThrow();
  });

  it("keeps expired candidates untouched while indexing active knowledge", async () => {
    const expired = { ...candidate("expired"), expiresAt: new Date(NOW - 1).toISOString() };
    const f = fixture({ ...snapshot(), learningCandidates: [candidate(), expired] });
    const context = await f.prepare();
    expect(context.entries.map(({ id }) => id)).toEqual(["candidate"]);
    expect((await f.repository.read()).learningCandidates![1]).toEqual(expired);
    expect(f.embed.mock.calls.flatMap(([input]) => input.texts)).not.toContain(expired.content);
  });
});
