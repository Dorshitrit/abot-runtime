import { describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import type { ApplyLearningDecisionsInput, LearningMemoryDecision } from "../long-term-memory/maturation/contracts.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";
import { parseMemorySnapshot } from "../long-term-memory/repository-state.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createReassessmentStateStore, learningReassessmentFingerprint } from "../passive-learning/reassessment-state.js";
import { reconcileCommittedReassessment } from "../passive-learning/reassessment-receipt.js";
import { ScheduledLearningReassessment } from "../passive-learning/scheduled-reassessment.js";
import { DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";

async function fixture(score = 50) {
  let time = Date.parse(score >= 90 ? "2026-09-24T10:00:00Z" : "2026-09-25T10:00:00Z");
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({ modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]) }));
  const memory = createLongTermMemoryService({ repository, embeddings: { embed }, enabled: true, emitClientEvents: false, now: () => new Date(time) });
  const signal = new AbortController().signal;
  const decision: LearningMemoryDecision = { action: "create", targetKind: "candidate", targetId: null, targetVersion: null,
    content: "Plans to research a new project next week.", tags: ["plans"], score, reason: "Observed a planning session.",
    certainty: "observed", reinforced: true, observationIds: ["observation"], mergedCandidateIds: [], reconsiderAt: "2026-09-25T10:01:00Z" };
  await memory.learning!.apply({ batchId: "observed", batchExpiresAt: "2026-09-26T10:00:00Z", environmentId: "dev",
    observations: [{ id: "observation", deviceId: "pc", timestamp: new Date(time).toISOString() }], abortSignal: signal,
    context: await memory.learning!.prepare({ query: "project", abortSignal: signal }), decisions: [decision], policy: DEFAULT_MATURATION_POLICY });
  if (score >= DEFAULT_MATURATION_POLICY.promotionScore) {
    time += 24 * 60 * 60 * 1000;
    const context = await memory.learning!.prepare({ query: "project", abortSignal: signal });
    const target = context.entries[0]!;
    await memory.learning!.apply({ batchId: "reinforced", batchExpiresAt: "2026-09-26T10:00:00Z", environmentId: "dev",
      observations: [{ id: "new-observation", deviceId: "pc", timestamp: new Date(time).toISOString() }], abortSignal: signal,
      context, decisions: [{ ...decision, action: "update", targetId: target.id, targetVersion: target.version,
        observationIds: ["new-observation"] }], policy: DEFAULT_MATURATION_POLICY });
  }
  const review = async (batchId = "review"): Promise<ApplyLearningDecisionsInput> => {
    const context = await memory.learning!.reconsiderationContext();
    return { batchId, batchExpiresAt: new Date(time + 60_000).toISOString(), environmentId: "dev", observations: [], abortSignal: signal,
      context, decisions: [], policy: DEFAULT_MATURATION_POLICY,
      cause: { kind: "scheduled_knowledge_review", dueEntries: context.entries.map(({ kind, id, version }) => ({ kind, id, version })) } };
  };
  const update = (input: ApplyLearningDecisionsInput, changes: Partial<LearningMemoryDecision> = {}): LearningMemoryDecision => {
    const target = input.context.entries[0]!;
    return { ...decision, action: "update", targetKind: target.kind, targetId: target.id, targetVersion: target.version,
      score: target.score ?? 0, observationIds: [], reinforced: false, reconsiderAt: null, ...changes };
  };
  return { repository, memory, embed, signal, review, update, advance: (ms: number) => { time += ms; } };
}

describe("explicit scheduled knowledge review", () => {
  it.each([50, 95])("reconciles a committed no-change review after restart without repeating inference (score %i)", async (score) => {
    const f = await fixture(score); f.advance(60_000);
    const input = await f.review();
    const fingerprint = learningReassessmentFingerprint(input.context);
    const parent = join(process.cwd(), ".codex/artifacts/co-worker-reassessment-receipt-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "fixture-"));
    const store = createReassessmentStateStore(directory);
    const review = vi.fn();
    const runner = new ScheduledLearningReassessment({ directory, environmentId: "dev", memory: f.memory.learning!,
      context: { preferences: () => ({ ...DEFAULT_LEARNING_PREFERENCES, processingPaused: false, modelProfileId: "model" }),
        changed() {}, isStarted: () => true, isInteractiveBusy: () => false, assertProcessingAllowed() {} },
      model: { review, extract: vi.fn(), validateProfile() {} }, resourceUsage: vi.fn(),
      now: () => Date.parse("2026-09-25T10:01:00Z") });
    try {
      await store.reserve(fingerprint, input.cause?.kind === "scheduled_knowledge_review" ? input.cause.dueEntries : [], Date.now(), () => {});
      await f.memory.learning!.apply({ ...input, batchId: `reassess-${fingerprint}` });
      f.embed.mockClear();
      const complete = vi.fn().mockRejectedValueOnce(new Error("temporary write failure"));
      await expect(reconcileCommittedReassessment({ ...store, complete }, f.memory.learning!)).rejects.toThrow("temporary write failure");
      expect((await store.read()).fingerprint).toBe(fingerprint);
      await runner.start();
      expect(await store.read()).toMatchObject({ fingerprint: null, blockedEntries: [], reason: null });
      expect(runner.status().nextReviewAt).toBeUndefined();
      expect(review).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled();
    } finally { await runner.stop(); await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves permanent-memory reconsideration on promotion and excludes manually protected records", async () => {
    const f = await fixture(95);
    expect(await f.memory.learning!.nextReconsiderationAt()).toBe("2026-09-25T10:01:00.000Z");
    expect((await f.memory.learning!.reconsiderationContext()).entries).toEqual([]);
    f.advance(60_000);
    const due = await f.memory.learning!.reconsiderationContext();
    expect(due.entries[0]).toMatchObject({ kind: "memory", reconsiderAt: "2026-09-25T10:01:00Z" });
    const snapshot = await f.repository.read();
    expect(parseMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    const record = snapshot.records[0]!;
    await f.memory.update({ id: record.id, expectedUpdatedAt: record.updatedAt, content: record.content, tags: record.tags, context: { abortSignal: f.signal } });
    expect(await f.memory.learning!.nextReconsiderationAt()).toBeNull();
    expect((await f.memory.learning!.reconsiderationContext()).entries).toEqual([]);
  });

  it("consumes a no-change deadline atomically without reinforcing, embedding or inventing evidence", async () => {
    const f = await fixture();
    const original = (await f.memory.learning!.list())[0]!;
    f.advance(60_000);
    const input = await f.review();
    f.embed.mockClear();
    const receipt = await f.memory.learning!.apply(input);
    const updated = (await f.memory.learning!.list())[0]!;
    expect(updated).toMatchObject({ content: original.content, score: original.score, sources: original.sources,
      lastReinforcedAt: original.lastReinforcedAt, expiresAt: original.expiresAt, reconsiderAt: null });
    expect(updated.revision).toBe(original.revision + 1);
    expect(receipt).toMatchObject({ recordIds: [], candidateIds: [] });
    expect(await f.memory.learning!.nextReconsiderationAt()).toBeNull();
    expect(await f.memory.learning!.apply(input)).toEqual(receipt);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("can lower candidate score and schedule another review without extending retention or promotion", async () => {
    const f = await fixture();
    const original = (await f.memory.learning!.list())[0]!;
    f.advance(60_000);
    const input = await f.review();
    f.embed.mockClear();
    await f.memory.learning!.apply({ ...input, policy: { ...input.policy, promotionScore: 20 },
      decisions: [f.update(input, { score: 35, reconsiderAt: "2026-09-26T10:00:00Z", reason: "The plan may need confirmation; elapsed time does not prove completion." })] });
    expect((await f.memory.learning!.list())[0]).toMatchObject({ score: 35, sources: original.sources,
      lastReinforcedAt: original.lastReinforcedAt, expiresAt: original.expiresAt, reconsiderAt: "2026-09-26T10:00:00Z" });
    expect((await f.memory.list()).total).toBe(0);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("stages a scheduled rewrite without fabricated evidence and consumes its original deadline", async () => {
    const f = await fixture(95);
    const original = (await f.memory.list()).items[0]!;
    f.advance(60_000);
    const input = await f.review();
    await f.memory.learning!.apply({ ...input, decisions: [f.update(input, {
      content: "Previously planned to research a new project; its current status is unknown.",
      reconsiderAt: "2026-09-25T10:02:00Z", certainty: "inferred",
    })] });
    const updated = (await f.memory.list()).items[0]!;
    expect(updated.provenance).toEqual(original.provenance);
    expect(updated.observationSources).toEqual(original.observationSources);
    expect(updated.content).toBe(original.content);
    expect(updated.reconsiderAt).toBeNull();
    const replacement = (await f.memory.learning!.list())[0]!;
    expect(replacement).toMatchObject({ sources: [], reinforcements: [],
      replacement: { id: original.id, version: updated.updatedAt }, reconsiderAt: "2026-09-25T10:02:00Z" });
    f.advance(60_000);
    const remove = await f.review("remove");
    await f.memory.learning!.apply({ ...remove, decisions: [f.update(remove, { action: "remove" })] });
    expect((await f.memory.list()).total).toBe(1);
    expect(await f.memory.learning!.list()).toEqual([]);
  });

  it.each([
    { action: "create" as const, targetId: null, targetVersion: null },
    { action: "merge" as const },
    { reinforced: true },
    { observationIds: ["observation"] },
    { score: 90 },
  ])("rejects actions unsupported by elapsed time: %j", async (changes) => {
    const f = await fixture();
    f.advance(60_000);
    const input = await f.review();
    const before = await f.repository.read();
    f.embed.mockClear();
    await expect(f.memory.learning!.apply({ ...input, decisions: [f.update(input, changes)] })).rejects.toThrow();
    expect(await f.repository.read()).toEqual(before);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("does not consume an edited or not-yet-due trigger from fabricated supplied context", async () => {
    const f = await fixture(95);
    const earlyContext = await f.memory.learning!.overview();
    const early = { ...await f.review(), context: earlyContext, cause: { kind: "scheduled_knowledge_review" as const,
      dueEntries: earlyContext.entries.map(({ kind, id, version }) => ({ kind, id, version })) } };
    await expect(f.memory.learning!.apply(early)).rejects.toThrow("learning_review_target_not_due");
    f.advance(60_000);
    const input = await f.review();
    const record = (await f.memory.list()).items[0]!;
    await f.memory.update({ id: record.id, expectedUpdatedAt: record.updatedAt, content: record.content, tags: ["mine"], context: { abortSignal: f.signal } });
    await expect(f.memory.learning!.apply(input)).rejects.toThrow("learning_knowledge_conflict");
    expect((await f.memory.list()).items[0]!.reconsiderAt).toBe(record.reconsiderAt);
  });

  it("bounds due context and consumes only the records actually reviewed", async () => {
    const f = await fixture(95);
    await f.repository.update((current) => ({ ...current,
      records: Array.from({ length: 15 }, (_, index) => ({ ...current.records[0]!, id: `memory-${index}`, content: `A distinct plan ${index}.` })),
      vectors: Array.from({ length: 15 }, (_, index) => ({ ...current.vectors[0]!, memoryId: `memory-${index}` })),
    }));
    f.advance(60_000);
    const input = await f.review();
    expect(input.context.entries).toHaveLength(12);
    expect(input.context.omitted).toBe(3);
    f.embed.mockClear();
    await f.memory.learning!.apply(input);
    expect((await f.memory.learning!.reconsiderationContext()).entries).toHaveLength(3);
    expect((await f.repository.read()).records.filter((record) => record.reconsiderAt === null)).toHaveLength(12);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("excludes failed bindings before the context limit and exposes the next future deadline", async () => {
    const f = await fixture(95);
    await f.repository.update((current) => ({ ...current,
      records: Array.from({ length: 16 }, (_, index) => ({ ...current.records[0]!, id: `memory-${index}`,
        content: `A distinct plan ${index}.`, reconsiderAt: index === 15 ? "2026-09-25T11:00:00Z" : current.records[0]!.reconsiderAt })),
      vectors: Array.from({ length: 16 }, (_, index) => ({ ...current.vectors[0]!, memoryId: `memory-${index}` })),
    }));
    f.advance(60_000);
    const initial = await f.memory.learning!.reconsiderationContext();
    const remaining = await f.memory.learning!.reconsiderationContext({ exclude: initial.entries });
    expect(remaining.entries).toHaveLength(3);
    expect(remaining.omitted).toBe(0);
    expect(remaining.entries.every((entry) => !initial.entries.some((blocked) => blocked.id === entry.id))).toBe(true);
    const exclude = [...initial.entries, ...remaining.entries];
    const before = await f.repository.read();
    f.embed.mockClear();
    expect((await f.memory.learning!.reconsiderationContext({ exclude })).entries).toEqual([]);
    expect(await f.memory.learning!.nextReconsiderationAt({ exclude })).toBe("2026-09-25T11:00:00.000Z");
    expect(await f.repository.read()).toEqual(before);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it.each([50, 95])("only excludes the exact kind, identity and version (score %i)", async (score) => {
    const f = await fixture(score);
    f.advance(60_000);
    const { entries } = await f.memory.learning!.reconsiderationContext();
    const blocked = entries[0]!;
    expect(await f.memory.learning!.nextReconsiderationAt({ exclude: entries })).toBeNull();
    expect((await f.memory.learning!.reconsiderationContext({ exclude: [{ ...blocked,
      kind: blocked.kind === "memory" ? "candidate" : "memory" }] })).entries).toHaveLength(1);
    await f.repository.update((current) => ({ ...current,
      records: current.records.map((record) => ({ ...record, updatedAt: "2026-09-25T10:01:00Z" })),
      learningCandidates: (current.learningCandidates ?? []).map((candidate) => ({ ...candidate, revision: candidate.revision + 1 })),
    }));
    const changed = await f.memory.learning!.reconsiderationContext({ exclude: entries });
    expect(changed.entries).toHaveLength(1);
    expect(changed.entries[0]!.version).not.toBe(blocked.version);
    expect(await f.memory.learning!.nextReconsiderationAt({ exclude: entries })).toBe("2026-09-25T10:01:00.000Z");
  });
});
