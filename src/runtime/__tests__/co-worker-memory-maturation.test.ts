import { describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import type { ApplyLearningDecisionsInput, LearningMemoryDecision } from "../long-term-memory/maturation/contracts.js";
import { DEFAULT_MATURATION_POLICY, retainLearningCandidates } from "../long-term-memory/maturation/retention.js";
import { parseMemorySnapshot } from "../long-term-memory/repository-state.js";

function fixture() {
  let time = Date.parse("2026-09-25T10:00:00Z");
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({ modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]) }));
  const memory = createLongTermMemoryService({ repository, embeddings: { embed }, enabled: true, emitClientEvents: false, now: () => new Date(time) });
  const signal = new AbortController().signal;
  const decision: LearningMemoryDecision = { action: "create", targetKind: "candidate", targetId: null, targetVersion: null,
    content: "Often works on TypeScript projects.", tags: ["workflow"], score: 45, reason: "One observed work session.",
    certainty: "observed", reinforced: true, observationIds: ["obs"], mergedCandidateIds: [], reconsiderAt: null };
  const input = async (batchId: string, changes: Partial<LearningMemoryDecision> = {}): Promise<ApplyLearningDecisionsInput> => ({
    batchId, batchExpiresAt: new Date(time + 60_000).toISOString(), environmentId: "dev",
    observations: [{ id: `${batchId}-obs`, deviceId: "pc", timestamp: new Date(time).toISOString() }], abortSignal: signal,
    context: await memory.learning!.prepare({ query: "TypeScript projects", abortSignal: signal }),
    decisions: [{ ...decision, observationIds: [`${batchId}-obs`], ...changes }], policy: DEFAULT_MATURATION_POLICY,
  });
  const promote = async (batchId: string) => {
    const first = await memory.learning!.apply(await input(`${batchId}-candidate`, { score: 95 }));
    return memory.learning!.apply(await input(batchId, { action: "update", targetId: first.candidateIds[0]!, targetVersion: "1", score: 95 }));
  };
  return { repository, memory, embed, input, promote, signal, advance: (ms: number) => { time += ms; } };
}

describe("Co-worker memory maturation", () => {
  it("keeps a weak candidate out of ordinary memory, then atomically promotes a reinforced version", async () => {
    const f = fixture();
    const first = await f.memory.learning!.apply(await f.input("first"));
    expect(first.recordIds).toEqual([]);
    expect(first.candidateIds).toHaveLength(1);
    expect((await f.memory.list()).total).toBe(0);
    const candidate = (await f.memory.learning!.list())[0]!;
    const input = await f.input("second", { action: "update", targetId: candidate.id, targetVersion: "1", score: 95 });
    f.embed.mockClear();
    const promoted = await f.memory.learning!.apply(input);
    expect(f.embed).not.toHaveBeenCalled();
    expect(promoted.recordIds).toEqual([candidate.id]);
    expect(await f.memory.learning!.list()).toEqual([]);
    expect((await f.memory.list()).items[0]).toMatchObject({ id: candidate.id, automaticManagement: "allowed" });
    const snapshot = await f.repository.read();
    expect(parseMemorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    await f.memory.delete({ id: candidate.id });
    expect(await f.memory.learning!.apply(input)).toEqual(promoted);
    expect((await f.memory.list()).total).toBe(0);
  });

  it("promotes at a configured score below 90 only after independent evidence matures", async () => {
    const f = fixture();
    await f.memory.learning!.configurePolicy({ ...DEFAULT_MATURATION_POLICY, promotionScore: 40 });
    const first = await f.memory.learning!.apply(await f.input("low-first", { score: 45 }));
    const id = first.candidateIds[0]!;
    expect(first.recordIds).toEqual([]);
    const second = await f.memory.learning!.apply(await f.input("low-second", { action: "update", targetId: id, targetVersion: "1", score: 45 }));
    expect(second.recordIds).toEqual([id]);
  });

  it("does not refresh retention or re-embed when only score changes without reinforcement", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    const old = (await f.memory.learning!.list())[0]!;
    f.advance(60_000);
    const input = await f.input("second", { action: "update", targetId: old.id, targetVersion: "1", score: 20, reinforced: false });
    f.embed.mockClear();
    await f.memory.learning!.apply(input);
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.memory.learning!.list())[0]).toMatchObject({ lastReinforcedAt: old.lastReinforcedAt, expiresAt: old.expiresAt, score: 20 });
    f.advance(30 * 86_400_000);
    expect(await f.memory.learning!.list()).toEqual([]);
  });

  it("commits unrelated concurrent creates prepared at the same repository revision", async () => {
    const f = fixture();
    const a = await f.input("a");
    const b = await f.input("b", { content: "Another candidate." });
    const receipts = await Promise.all([f.memory.learning!.apply(a), f.memory.learning!.apply(b)]);
    expect(receipts.every((receipt) => receipt.candidateIds.length === 1)).toBe(true);
    expect(await f.memory.learning!.list()).toHaveLength(2);
  });

  it("allows simultaneous changes to different bound candidates", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    await f.memory.learning!.apply(await f.input("second", { content: "Prefers separate research notes." }));
    const [first, second] = await f.memory.learning!.list();
    const a = await f.input("update-first", { action: "update", targetId: first!.id, targetVersion: "1", content: first!.content, score: 50 });
    const b = await f.input("update-second", { action: "update", targetId: second!.id, targetVersion: "1", content: second!.content, score: 60 });
    expect(a.context.repositoryRevision).toBe(b.context.repositoryRevision);
    f.embed.mockClear();
    await Promise.all([f.memory.learning!.apply(a), f.memory.learning!.apply(b)]);
    expect((await f.memory.learning!.list()).map((candidate) => candidate.score).sort()).toEqual([50, 60]);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("rejects a stale same-target decision and simultaneous exact duplicate creation", async () => {
    const f = fixture();
    const a = await f.input("create-a");
    const b = await f.input("create-b");
    const creates = await Promise.allSettled([f.memory.learning!.apply(a), f.memory.learning!.apply(b)]);
    expect(creates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(creates.find((result) => result.status === "rejected")).toMatchObject({ reason: new Error("learning_duplicate_requires_bound_update") });
    const target = (await f.memory.learning!.list())[0]!;
    const first = await f.input("update-a", { action: "update", targetId: target.id, targetVersion: "1", score: 51 });
    const second = await f.input("update-b", { action: "update", targetId: target.id, targetVersion: "1", score: 61 });
    const updates = await Promise.allSettled([f.memory.learning!.apply(first), f.memory.learning!.apply(second)]);
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.find((result) => result.status === "rejected")).toMatchObject({ reason: new Error("learning_knowledge_conflict") });
    expect((await f.memory.learning!.list())[0]!.revision).toBe(2);
  });

  it("preserves the source on embedding failure and cancellation", async () => {
    const f = fixture();
    const input = await f.input("a");
    f.embed.mockRejectedValueOnce(new Error("offline"));
    await expect(f.memory.learning!.apply(input)).rejects.toThrow("offline");
    expect((await f.repository.read()).revision).toBe(0);
    const abort = new AbortController();
    f.embed.mockImplementationOnce(async ({ texts }) => {
      abort.abort();
      return { modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]) };
    });
    await expect(f.memory.learning!.apply({ ...input, abortSignal: abort.signal })).rejects.toThrow();
    expect((await f.repository.read()).revision).toBe(0);
  });

  it("requires new index compatibility without silently rebuilding or duplicating candidates", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("a"));
    f.embed.mockResolvedValue({ modelFingerprint: "changed", dimensions: 2, vectors: [[1, 0]] });
    await expect(f.input("b")).rejects.toThrow("learning_embedding_reindex_required");
    expect(await f.memory.learning!.list()).toHaveLength(1);
  });

  it("rejects unknown sources, protected memory, and expired replay before writing", async () => {
    const f = fixture();
    await expect(f.memory.learning!.apply(await f.input("bad", { observationIds: ["missing"] }))).rejects.toThrow("learning_decision_source_unknown");
    const manual = await f.memory.create({ content: "TypeScript projects are important.", tags: [], source: "web_ui", context: { abortSignal: f.signal } });
    await expect(f.memory.learning!.apply(await f.input("protected", { action: "remove", targetKind: "memory", targetId: manual.record.id, targetVersion: manual.record.updatedAt }))).rejects.toThrow("learning_memory_protected");
    const expired = await f.input("expired");
    f.advance(60_001);
    await expect(f.memory.learning!.apply(expired)).rejects.toThrow("learning_batch_expired");
    expect((await f.memory.list()).total).toBe(1);
  });

  it("evicts temporary candidates by bounded capacity without touching permanent memory", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("a", { score: 30 }));
    const b = await f.input("b", { content: "Sometimes explores database tooling.", score: 50 });
    await f.memory.learning!.configurePolicy({ ...b.policy, maxCandidates: 1 });
    await f.memory.learning!.apply({ ...b, policy: { ...b.policy, maxCandidates: 1 } });
    const records = await f.memory.learning!.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.score).toBe(50);
    expect(retainLearningCandidates(records, { ...DEFAULT_MATURATION_POLICY, maxBytes: 1024 }, Date.parse(records[0]!.createdAt)).length).toBeLessThanOrEqual(1);
  });

  it("rejects forged target versions even when the supplied context claims the latest repository revision", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    const candidate = (await f.memory.learning!.list())[0]!;
    const input = await f.input("forged", { action: "update", targetId: candidate.id, targetVersion: "99", score: 99 });
    const forged = { ...input, context: { ...input.context, entries: input.context.entries.map((entry) => ({ ...entry, version: "99" })) } };
    f.embed.mockClear();
    await expect(f.memory.learning!.apply(forged)).rejects.toThrow("learning_knowledge_conflict");
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.memory.learning!.list())[0]).toEqual(candidate);
  });

  it("cannot recreate a deleted target using fabricated current context", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    const candidate = (await f.memory.learning!.list())[0]!;
    const input = await f.input("deleted", { action: "update", targetId: candidate.id, targetVersion: "1", score: 99 });
    const snapshot = await f.repository.update((current) => ({ ...current, learningCandidates: [] }));
    const forged = { ...input, context: { ...input.context, repositoryRevision: snapshot.revision } };
    await expect(f.memory.learning!.apply(forged)).rejects.toThrow("learning_decision_target_unknown");
    expect(await f.memory.learning!.list()).toEqual([]);
    expect((await f.memory.list()).total).toBe(0);
  });

  it("merges only current candidates and retains bounded evidence from both", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    await f.memory.learning!.apply(await f.input("second", { content: "Often checks TypeScript release notes." }));
    const [target, source] = await f.memory.learning!.list();
    const merge = await f.input("merge", { action: "merge", targetId: target!.id, targetVersion: "1", mergedCandidateIds: [source!.id], score: 70 });
    f.embed.mockClear();
    await f.memory.learning!.apply(merge);
    const remaining = await f.memory.learning!.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(target!.id);
    expect(remaining[0]!.sources.map((entry) => entry.kind === "passive_observation" ? entry.batchId : "conversation")).toEqual(["first", "second", "merge"]);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("rejects a stale merge source and a source that expired without a repository write", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    await f.memory.learning!.apply(await f.input("second", { content: "Often checks TypeScript release notes." }));
    const [target, source] = await f.memory.learning!.list();
    const merge = await f.input("stale-merge", { action: "merge", targetId: target!.id, targetVersion: "1", mergedCandidateIds: [source!.id] });
    await f.memory.learning!.apply(await f.input("source-update", { action: "update", targetId: source!.id, targetVersion: "1", content: source!.content, score: 60 }));
    const current = await f.repository.read();
    await expect(f.memory.learning!.apply({ ...merge, context: { ...merge.context, repositoryRevision: current.revision } })).rejects.toThrow("learning_knowledge_conflict");
    const freshMerge = await f.input("expired-merge", { action: "merge", targetId: target!.id, targetVersion: "1", mergedCandidateIds: [source!.id] });
    f.advance(30 * 86_400_000);
    await expect(f.memory.learning!.apply({ ...freshMerge, batchExpiresAt: "2026-11-01T00:00:00Z" })).rejects.toThrow("learning_candidate_expired");
    expect((await f.repository.read()).learningCandidates).toHaveLength(2);
  });

  it("stages automatic content changes but still binds removal to the current memory version", async () => {
    const f = fixture();
    const saved = await f.promote("promote");
    const record = (await f.memory.list()).items[0]!;
    const changed = "Previously worked mainly on TypeScript; now also uses Rust.";
    await f.memory.learning!.apply(await f.input("revise", { action: "update", targetKind: "memory", targetId: record.id, targetVersion: record.updatedAt, content: changed }));
    const revised = (await f.memory.list()).items[0]!;
    expect(revised.content).toBe(record.content);
    expect((await f.memory.learning!.list())[0]).toMatchObject({ content: changed, replacement: { id: record.id, version: record.updatedAt } });
    expect(revised.provenance).toEqual(record.provenance);
    expect((await f.repository.read()).vectors[0]?.memoryId).toBe(saved.recordIds[0]);
    f.embed.mockClear();
    const removal = await f.input("remove", { action: "remove", targetKind: "memory", targetId: revised.id, targetVersion: revised.updatedAt });
    f.embed.mockClear();
    await f.memory.learning!.apply(removal);
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.repository.read()).records).toEqual([]);
    expect((await f.repository.read()).vectors).toEqual([]);
  });

  it("manual edits beat in-flight automatic decisions, even with fabricated context revision", async () => {
    const f = fixture();
    await f.promote("promote");
    const record = (await f.memory.list()).items[0]!;
    const removal = await f.input("remove", { action: "remove", targetKind: "memory", targetId: record.id, targetVersion: record.updatedAt });
    const edited = await f.memory.update({ id: record.id, expectedUpdatedAt: record.updatedAt, content: record.content, tags: ["mine"], context: { abortSignal: f.signal } });
    const snapshot = await f.repository.read();
    await expect(f.memory.learning!.apply({ ...removal, context: { ...removal.context, repositoryRevision: snapshot.revision } })).rejects.toThrow("learning_knowledge_conflict");
    expect((await f.memory.list()).items).toEqual([edited.record]);
  });

  it("rejects an embedding model changed after context preparation", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    const second = await f.input("second", { content: "Often reviews database migrations." });
    f.embed.mockResolvedValueOnce({ modelFingerprint: "changed", dimensions: 2, vectors: [[1, 0]] });
    await expect(f.memory.learning!.apply(second)).rejects.toThrow("long_term_memory_embedding_binding_changed");
    expect(await f.memory.learning!.list()).toHaveLength(1);
  });

  it("removes expired disk state only when due, without inference or repeated writes", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    const before = await f.repository.read();
    f.embed.mockClear();
    expect(await f.memory.learning!.nextExpiryAt(DEFAULT_MATURATION_POLICY)).toBe("2026-09-25T10:01:00.000Z");
    expect(await f.memory.learning!.maintenance(DEFAULT_MATURATION_POLICY)).toMatchObject({ removedCandidateCount: 0, removedReceiptCount: 0 });
    expect((await f.repository.read()).revision).toBe(before.revision);
    f.advance(60_001);
    expect(await f.memory.learning!.maintenance(DEFAULT_MATURATION_POLICY)).toMatchObject({ removedCandidateCount: 0, removedReceiptCount: 1, nextExpiryAt: "2026-10-25T10:00:00.000Z" });
    f.advance(30 * 86_400_000);
    expect(await f.memory.learning!.maintenance(DEFAULT_MATURATION_POLICY)).toEqual({ removedCandidateCount: 1, removedReceiptCount: 0, nextExpiryAt: null });
    const settled = await f.repository.read();
    expect(settled.learningCandidates).toEqual([]);
    expect(settled.learningReceipts).toEqual([]);
    await f.memory.learning!.maintenance(DEFAULT_MATURATION_POLICY);
    expect((await f.repository.read()).revision).toBe(settled.revision);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("counts vector bytes and applies a reduced retention limit without changing permanent memory", async () => {
    const f = fixture();
    await f.promote("permanent");
    const permanent = (await f.memory.list()).items;
    await f.memory.learning!.apply(await f.input("candidate", { content: "May explore database architecture." }));
    const records = await f.memory.learning!.list();
    const larger = [{ ...records[0]!, embedding: { ...records[0]!.embedding, dimensions: 2000, vector: Array(2000).fill(0.12345) } }];
    expect(retainLearningCandidates(larger, { ...DEFAULT_MATURATION_POLICY, maxBytes: 1024 }, Date.parse(records[0]!.createdAt))).toEqual([]);
    f.advance(2 * 86_400_000);
    await f.memory.learning!.configurePolicy({ ...DEFAULT_MATURATION_POLICY, retentionDays: 1 });
    await f.memory.retention!.start(); // Settle the refresh already triggered by the policy commit.
    expect((await f.repository.read()).learningCandidates).toEqual([]);
    const result = await f.memory.learning!.maintenance({ ...DEFAULT_MATURATION_POLICY, retentionDays: 1 });
    expect(result.removedCandidateCount).toBe(0);
    expect((await f.memory.list()).items).toEqual(permanent);
  });

  it("normalizes direct decision input and rejects sensitive tags before embedding", async () => {
    const f = fixture();
    await expect(f.memory.learning!.apply(await f.input("secret-tag", { tags: ["api_key=private-value"] }))).rejects.toThrow("learning_content_sensitive");
    expect(f.embed).not.toHaveBeenCalled();
    await f.memory.learning!.apply(await f.input("whitespace", { content: `Uses${" ".repeat(10_000)}TypeScript.`, tags: [" Workflow "] }));
    expect((await f.memory.learning!.list())[0]).toMatchObject({ content: "Uses TypeScript.", tags: ["workflow"] });
  });
});
