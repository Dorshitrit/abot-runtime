import { describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import type { ApplyLearningDecisionsInput, LearningCandidateRecord, LearningMemoryDecision } from "../long-term-memory/maturation/contracts.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";

type Observation = ApplyLearningDecisionsInput["observations"][number];
const observation = (id: string, changes: Partial<Observation> = {}): Observation => ({
  id, deviceId: "computer", timestamp: "2026-09-25T09:00:00Z", ...changes,
});
function fixture() {
  let now = Date.parse("2026-09-25T10:00:00Z");
  const signal = new AbortController().signal;
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
    modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
  }));
  const memory = createLongTermMemoryService({ repository, embeddings: { embed }, enabled: true,
    emitClientEvents: false, now: () => new Date(now) });
  const input = async (batchId: string, observations = [observation(batchId)], changes: Partial<LearningMemoryDecision> = {}): Promise<ApplyLearningDecisionsInput> => ({
    batchId, batchExpiresAt: new Date(now + 86_400_000).toISOString(), environmentId: "dev", observations,
    abortSignal: signal, policy: DEFAULT_MATURATION_POLICY,
    context: await memory.learning!.prepare({ query: "work", abortSignal: signal }),
    decisions: [{ action: "create", targetKind: "candidate", targetId: null, targetVersion: null,
      content: "Often develops TypeScript projects.", tags: [], score: 100, reason: "Observed substantive evidence.",
      certainty: "observed", observationIds: observations.map(item => item.id), reinforced: true,
      mergedCandidateIds: [], reconsiderAt: null, ...changes }],
  });
  const update = (target: LearningCandidateRecord, changes: Partial<LearningMemoryDecision> = {}): Partial<LearningMemoryDecision> => ({
    action: "update", targetId: target.id, targetVersion: String(target.revision), ...changes,
  });
  return { repository, memory, embed, input, update, advance: (ms: number) => { now += ms; } };
}

describe("candidate-first promotion with fresh evidence", () => {
  it("persists even a score of 100 as a candidate and replays its receipt without promotion", async () => {
    const f = fixture();
    const input = await f.input("first");
    const receipt = await f.memory.learning!.apply(input);
    expect(receipt.recordIds).toEqual([]);
    expect(receipt.candidateIds).toHaveLength(1);
    expect((await f.memory.learning!.list())[0]).toMatchObject({ score: 100, revision: 1 });
    expect((await f.memory.list()).total).toBe(0);
    const snapshot = await f.repository.read();
    f.embed.mockClear();
    expect(await f.memory.learning!.apply(input)).toEqual(receipt);
    expect(await f.repository.read()).toEqual(snapshot);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("keeps split batches of the same observation provisional", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    const target = (await f.memory.learning!.list())[0]!;
    const second = await f.input("second", [observation("new", { timestamp: "2026-09-25T09:30:00Z", revisitsObservationId: "first" })], f.update(target));
    expect(Date.parse(second.observations[0]!.timestamp)).toBeLessThan(Date.parse(target.createdAt));
    f.embed.mockClear();
    const receipt = await f.memory.learning!.apply(second);
    expect(receipt.recordIds).toEqual([]);
    expect(await f.memory.learning!.list()).toHaveLength(1);
    expect((await f.memory.list()).items).toEqual([]);
    expect((await f.memory.learning!.list())[0]!.reinforcements).toHaveLength(1);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it.each([
    { name: "no semantic reinforcement", observations: [observation("new")], changes: { reinforced: false } },
    { name: "same observation under another batch", observations: [observation("first")], changes: {} },
    { name: "explicit unchanged revisit", observations: [observation("new", { revisitsObservationId: "first" })], changes: {} },
    { name: "queue-detected unchanged revisit", observations: [observation("new", { revisit: { firstObservedAt: "2026-09-25T09:00:00Z", contentUnchanged: true } })], changes: {} },
    { name: "uncited fresh observation", observations: [observation("first"), observation("new")], changes: { observationIds: ["first"] } },
  ])("keeps $name provisional without extending retention", async ({ observations, changes }) => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    const target = (await f.memory.learning!.list())[0]!;
    f.advance(60_000);
    await f.memory.learning!.apply(await f.input("second", observations, f.update(target, changes)));
    expect((await f.memory.learning!.list())[0]).toMatchObject({ id: target.id, score: 100,
      lastReinforcedAt: target.lastReinforcedAt, expiresAt: target.expiresAt });
    expect((await f.memory.list()).total).toBe(0);
  });

  it("does not turn a changed response for the same committed batch into new evidence", async () => {
    const f = fixture();
    const receipt = await f.memory.learning!.apply(await f.input("first"));
    const target = (await f.memory.learning!.list())[0]!;
    const snapshot = await f.repository.read();
    const replay = await f.input("first", [observation("other")], f.update(target));
    expect(await f.memory.learning!.apply(replay)).toEqual(receipt);
    expect(await f.repository.read()).toEqual(snapshot);
  });

  it("refreshes a genuinely reinforced candidate below the promotion threshold without establishing it", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first", undefined, { score: 40 }));
    const target = (await f.memory.learning!.list())[0]!;
    f.advance(60_000);
    await f.memory.learning!.apply(await f.input("second", undefined, f.update(target, { score: 70 })));
    const reinforced = (await f.memory.learning!.list())[0]!;
    expect(reinforced.score).toBe(70);
    expect(Date.parse(reinforced.lastReinforcedAt)).toBe(Date.parse(target.lastReinforcedAt) + 60_000);
    expect((await f.memory.list()).total).toBe(0);
  });

  it("does not use merged candidate history to bypass independent opportunities", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    await f.memory.learning!.apply(await f.input("source", undefined, { content: "Checks TypeScript project diagnostics." }));
    const candidates = await f.memory.learning!.list();
    const target = candidates.find(candidate => candidate.sources[0]!.kind === "passive_observation" && candidate.sources[0].batchId === "first")!;
    const source = candidates.find(candidate => candidate.id !== target.id)!;
    const merge = await f.input("merge", [observation("fresh")], f.update(target, { action: "merge", mergedCandidateIds: [source.id], reinforced: false }));
    await f.memory.learning!.apply(merge);
    expect(await f.memory.learning!.list()).toHaveLength(1);
    expect((await f.memory.list()).items).toEqual([]);
  });

  it("does not count evidence inherited from the merged candidate as fresh reinforcement", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    await f.memory.learning!.apply(await f.input("source", undefined, { content: "Checks TypeScript project diagnostics." }));
    const candidates = await f.memory.learning!.list();
    const target = candidates.find(candidate => candidate.sources[0]!.kind === "passive_observation" && candidate.sources[0].batchId === "first")!;
    const source = candidates.find(candidate => candidate.id !== target.id)!;
    f.advance(60_000);
    await f.memory.learning!.apply(await f.input("merge", [observation("source")], f.update(target, {
      action: "merge", mergedCandidateIds: [source.id],
    })));
    expect((await f.memory.list()).total).toBe(0);
    expect(await f.memory.learning!.list()).toHaveLength(1);
    expect((await f.memory.learning!.list())[0]).toMatchObject({ id: target.id, score: 100,
      lastReinforcedAt: target.lastReinforcedAt, expiresAt: target.expiresAt });
  });

  it("scopes observation identity to the originating device", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    const target = (await f.memory.learning!.list())[0]!;
    await f.memory.learning!.apply(await f.input("second", [observation("first", { deviceId: "another-computer" })], f.update(target)));
    expect((await f.memory.list()).items[0]!.observationSources).toHaveLength(2);
  });

  it("cannot count companion evidence dated in the future", async () => {
    const f = fixture();
    await f.memory.learning!.apply(await f.input("first"));
    for (const [index, timestamp] of ["2026-09-25T21:00:00Z", "2026-09-26T09:00:00Z"].entries()) {
      const target = (await f.memory.learning!.list())[0]!;
      await f.memory.learning!.apply(await f.input(`future-${index}`, [observation(`future-${index}`, { timestamp })], f.update(target)));
    }
    expect((await f.memory.learning!.list())[0]!.reinforcements).toHaveLength(1);
    expect((await f.memory.list()).items).toEqual([]);
  });
});
