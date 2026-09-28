import { describe, expect, it } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";
import { buildLearningReviewMessages } from "../passive-learning/memory-review-format.js";
import { createLearningReviewPresentation, type LearningReviewInput } from "../passive-learning/review-references.js";
import { createLearningReviewFormat } from "../passive-learning/review-response-format.js";
import { decodeLearningReviewDecisions } from "../passive-learning/review-decision-adapter.js";

const content = "Often works on TypeScript projects.";
function wire(changes: Record<string, unknown> = {}) {
  return { action: "create", content, tags: ["workflow"], score: 45,
    reason: "Observed a substantive work session.", certainty: "observed", reconsiderAt: null,
    evidence: ["o1"], ...changes };
}
function bind(input: LearningReviewInput) {
  const presentation = createLearningReviewPresentation(input);
  const format = createLearningReviewFormat(presentation.references);
  const decode = (decisions: readonly unknown[]) => decodeLearningReviewDecisions(JSON.stringify({ decisions }), presentation.references, format);
  const ref = (id: string) => [...presentation.references.knowledge].find(([, entry]) => entry.id === id)![0];
  return { input, presentation, format, decode, ref };
}
function fixture() {
  let time = Date.parse("2026-09-25T10:00:00Z");
  const signal = new AbortController().signal;
  const repository = createInMemoryLongTermMemoryRepository();
  const memory = createLongTermMemoryService({ repository, enabled: true, emitClientEvents: false,
    now: () => new Date(time), embeddings: { embed: async ({ texts }) => ({
      modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
    }) } });
  const input = async (batchId: string): Promise<LearningReviewInput> => ({
    batchId, modelProfileId: "test", signal, promotionScore: DEFAULT_MATURATION_POLICY.promotionScore,
    context: await memory.learning!.prepare({ query: "TypeScript", abortSignal: signal }),
    observations: [{ id: `private-observation-${batchId}`, deviceId: "private-device", timestamp: new Date(time).toISOString(),
      sequence: 42, source: { app: "editor", windowId: "private-window", documentId: "private-document", processId: 8123 },
      content: "Editing a TypeScript project.", kind: "edit", extraction: "uia", coverage: "partial" }],
  });
  const apply = (review: ReturnType<typeof bind>, rows: readonly unknown[]) => memory.learning!.apply({
    ...review.input, environmentId: "dev", batchExpiresAt: new Date(time + 60_000).toISOString(),
    abortSignal: signal, decisions: review.decode(rows), policy: DEFAULT_MATURATION_POLICY,
  });
  const create = async (batchId: string, changes: Record<string, unknown> = {}) => apply(bind(await input(batchId)), [wire(changes)]);
  return { repository, memory, signal, input, apply, create, advance: (ms: number) => { time += ms; } };
}

describe("compact learning references at the real memory boundary", () => {
  it("creates, promotes, updates and removes through exact canonical identities and original evidence", async () => {
    const f = fixture();
    const created = await f.create("create");
    const id = created.candidateIds[0]!;
    const candidate = (await f.memory.learning!.list())[0]!;
    expect(candidate).toMatchObject({ id, score: 45, content });
    expect(candidate.sources[0]).toMatchObject({ observationIds: ["private-observation-create"], deviceId: "private-device" });
    expect((await f.memory.list()).total).toBe(0);
    f.advance(12 * 60 * 60 * 1000);
    const reinforce = bind(await f.input("reinforce"));
    const receipt = await f.apply(reinforce, [wire({ action: "update", target: reinforce.ref(id), score: 95, reinforced: true })]);
    expect(receipt.recordIds).toEqual([id]);
    expect(await f.memory.learning!.list()).toEqual([]);
    const original = (await f.memory.list()).items[0]!;
    const update = bind(await f.input("update"));
    await f.apply(update, [wire({ action: "update", target: update.ref(id), content: "Also works on Rust projects.", reinforced: true })]);
    const current = (await f.memory.list()).items[0]!;
    expect(current).toMatchObject({ id, content, automaticManagement: "allowed", provenance: original.provenance });
    expect((await f.memory.learning!.list())[0]).toMatchObject({ content: "Also works on Rust projects.", replacement: { id, version: original.updatedAt } });
    const remove = bind(await f.input("remove"));
    await f.apply(remove, [{ action: "remove", target: remove.ref(id), reason: "New evidence retracts this claim.", evidence: ["o1"] }]);
    expect((await f.repository.read()).records).toEqual([]);
    expect((await f.repository.read()).vectors).toEqual([]);
  });

  it("keeps protected knowledge readable but excludes it from writable references", async () => {
    const f = fixture();
    const { record } = await f.memory.create({ content: "I prefer TypeScript.", tags: [], source: "web_ui", context: { abortSignal: f.signal } });
    const review = bind(await f.input("protected"));
    const before = await f.repository.read();
    expect(review.presentation.knowledge.entries).toContainEqual(expect.objectContaining({ content: record.content, mutable: false }));
    expect(review.presentation.references.targetRefs).not.toContain(review.ref(record.id));
    expect(() => review.decode([{ action: "remove", target: review.ref(record.id), reason: "Attempted change.", evidence: ["o1"] }])).toThrow("learning_memory_protected");
    expect(await f.repository.read()).toEqual(before);
  });

  it("merges bound candidates atomically while preserving their original evidence", async () => {
    const f = fixture();
    const targetId = (await f.create("target")).candidateIds[0]!;
    const sourceId = (await f.create("source", { content: "Checks TypeScript project diagnostics." })).candidateIds[0]!;
    const review = bind(await f.input("merge"));
    await f.apply(review, [wire({ action: "merge", target: review.ref(targetId), sources: [review.ref(sourceId)],
      score: 70, reinforced: false })]);
    const candidates = await f.memory.learning!.list();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: targetId, score: 70 });
    expect(candidates[0]!.sources.map(source => source.kind === "passive_observation" ? source.batchId : "conversation")).toEqual(["target", "source", "merge"]);
  });

  it("does not rebind an in-flight alias after another review changes its target", async () => {
    const f = fixture();
    const id = (await f.create("create")).candidateIds[0]!;
    const stale = bind(await f.input("stale"));
    const concurrent = bind(await f.input("concurrent"));
    await f.apply(concurrent, [wire({ action: "update", target: concurrent.ref(id), score: 60, reinforced: false })]);
    const before = await f.repository.read();
    await expect(f.apply(stale, [wire({ action: "update", target: stale.ref(id), score: 90, reinforced: true })])).rejects.toThrow("learning_knowledge_conflict");
    expect(await f.repository.read()).toEqual(before);
  });

  it("projects only call-local references without mutating evidence or exposing private identity fields", async () => {
    const f = fixture();
    await f.create("seed", { reconsiderAt: "2026-09-25T10:01:00Z" });
    f.advance(60_000);
    const input = await f.input("projection");
    const withRevisit = { ...input, observations: [
      { ...input.observations[0]!, revisitsObservationId: "private-older-observation" },
      { ...input.observations[0]!, id: "private-repeat", revisitsObservationId: input.observations[0]!.id },
      { ...input.observations[0]!, id: "private-unchanged", revisit: { firstObservedAt: "2026-09-25T09:00:00Z", contentUnchanged: true as const } },
    ] };
    const original = JSON.stringify(withRevisit);
    for (const scheduled of [false, true]) {
      const request: LearningReviewInput = scheduled ? { ...withRevisit, observations: [], cause: {
        kind: "scheduled_knowledge_review", dueEntries: input.context.entries.map(({ kind, id, version }) => ({ kind, id, version })),
      } } : withRevisit;
      const review = bind(request);
      const messages = JSON.stringify(buildLearningReviewMessages(request, review.presentation));
      for (const secret of ["private-observation-projection", "private-device", "private-window", "private-document", "private-older-observation", "private-repeat", "private-unchanged", ...input.context.entries.map(entry => entry.id)])
        expect(messages).not.toContain(secret);
      for (const key of ["targetVersion", "version", "deviceId", "processId", "sequence"])
        expect(messages).not.toContain(`\\\"${key}\\\"`);
      expect(review.presentation.knowledge.entries[0]).toMatchObject({ ref: "k1", content });
      if (scheduled) expect(messages).toContain("dueTargets");
      else {
        expect(review.decode([wire()])[0]!.observationIds).toEqual([input.observations[0]!.id]);
        expect(review.presentation.observations[0]).toMatchObject({ revisited: true });
        expect(review.presentation.observations[1]).toMatchObject({ revisited: true, revisits: "o1" });
        expect(review.presentation.observations[2]).toMatchObject({ revisited: true });
      }
    }
    expect(JSON.stringify(withRevisit)).toBe(original);
  });

  it("isolates identical short reference names across review snapshots", async () => {
    const first = fixture(), second = fixture();
    const firstId = (await first.create("a")).candidateIds[0]!;
    const secondId = (await second.create("b")).candidateIds[0]!;
    const a = bind(await first.input("a-review")), b = bind(await second.input("b-review"));
    const compact = wire({ action: "update", target: "k1", reinforced: false });
    expect(a.decode([compact])[0]).toMatchObject({ targetId: firstId, targetVersion: "1", observationIds: ["private-observation-a-review"] });
    expect(b.decode([compact])[0]).toMatchObject({ targetId: secondId, targetVersion: "1", observationIds: ["private-observation-b-review"] });
    expect(firstId).not.toBe(secondId);
    expect(() => a.decode([wire({ evidence: ["o2"] })])).toThrow("learning_decision_source_unknown");
  });

  it("rejects scheduled reinforcement, score increases and non-due targets; no-change consumes only due triggers", async () => {
    const f = fixture();
    const dueId = (await f.create("due", { reconsiderAt: "2026-09-25T10:01:00Z" })).candidateIds[0]!;
    const futureId = (await f.create("future", { content: "Reads TypeScript release notes.", reconsiderAt: "2026-09-26T10:00:00Z" })).candidateIds[0]!;
    f.advance(60_000);
    const input = await f.input("scheduled");
    const due = input.context.entries.find(entry => entry.id === dueId)!;
    const review = bind({ ...input, observations: [], cause: { kind: "scheduled_knowledge_review", dueEntries: [{ kind: due.kind, id: due.id, version: due.version }] } });
    const { evidence: _evidence, ...update } = wire({ action: "update", target: review.ref(dueId) });
    const before = await f.memory.learning!.list();
    expect(() => review.decode([{ ...update, reinforced: true }])).toThrow("learning_review_output_contract_invalid");
    expect(() => review.decode([{ ...update, target: review.ref(futureId) }])).toThrow("learning_review_target_not_due");
    await expect(f.apply(review, [{ ...update, score: 90 }])).rejects.toThrow("learning_review_cannot_raise_score");
    expect(await f.memory.learning!.list()).toEqual(before);
    await f.apply(review, []);
    const after = await f.memory.learning!.list();
    const original = before.find(item => item.id === dueId)!;
    expect(after.find(item => item.id === dueId)).toMatchObject({ score: original.score, sources: original.sources,
      lastReinforcedAt: original.lastReinforcedAt, expiresAt: original.expiresAt, reconsiderAt: null });
    expect(after.find(item => item.id === futureId)).toEqual(before.find(item => item.id === futureId));
    expect((await f.memory.list()).total).toBe(0);
  });
});
