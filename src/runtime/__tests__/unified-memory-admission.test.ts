import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import type { MemoryCandidate } from "../long-term-memory/contracts.js";
import type { LearningKnowledgeEntry, LearningMemoryDecision } from "../long-term-memory/maturation/contracts.js";
import { candidateKnowledge } from "../long-term-memory/maturation/context.js";

const HALF_DAY = 12 * 60 * 60 * 1000;
const CONTENT = "Prefers concise written explanations with concrete examples.";

function fixture() {
  let time = Date.parse("2026-09-25T10:00:00Z");
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
    modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
  }));
  const memory = createLongTermMemoryService({ repository, embeddings: { embed }, enabled: true,
    emitClientEvents: false, now: () => new Date(time) });
  const signal = new AbortController().signal;
  const conversation = async (requestId: string, changes: {
    score?: number; digest?: string; content?: string; target?: LearningKnowledgeEntry; reinforced?: boolean;
  } = {}) => {
    const target = changes.target ?? (await memory.learning!.list())[0];
    const bound = target && ("revision" in target ? candidateKnowledge(target) : target);
    const candidate: MemoryCandidate = {
      content: changes.content ?? CONTENT, tags: ["preference"],
      assessment: { score: changes.score ?? 95, reason: "A lasting communication preference confirmed by the user.",
        reinforced: changes.reinforced ?? true,
        evidence: { sourceSessionId: "chat", sourceRequestId: requestId, observedAt: new Date(time).toISOString(),
          evidenceDigest: createHash("sha256").update(changes.digest ?? requestId).digest("hex") },
        ...(bound ? { target: bound } : {}),
      },
    };
    return memory.processCandidates({ candidates: [candidate], context: { requestId, sessionId: "chat", abortSignal: signal } });
  };
  const observation = async (batchId: string, changes: Partial<LearningMemoryDecision> = {}) => {
    const context = await memory.learning!.prepare({ query: CONTENT, abortSignal: signal });
    const target = context.entries.find(entry => entry.kind === "candidate");
    return memory.learning!.apply({ batchId, batchExpiresAt: new Date(time + 86_400_000).toISOString(),
      environmentId: "dev", observations: [{ id: batchId, deviceId: "pc", timestamp: new Date(time).toISOString() }],
      abortSignal: signal, context, policy: await memory.learning!.policy(),
      decisions: [{ action: target ? "update" : "create", targetKind: "candidate", targetId: target?.id ?? null,
        targetVersion: target?.version ?? null, content: CONTENT, tags: ["preference"], score: 95,
        reason: "Independent activity confirms lasting usefulness.", certainty: "inferred", observationIds: [batchId],
        reinforced: true, mergedCandidateIds: [], reconsiderAt: null, ...changes }],
    });
  };
  return { memory, repository, embed, signal, conversation, observation, advance: (ms = HALF_DAY) => { time += ms; } };
}

describe("one admission owner for automatic memory", () => {
  it("matures conversation knowledge without a running Co-worker after two independent opportunities, regardless of elapsed time", async () => {
    const f = fixture();
    expect(await f.conversation("one", { score: 100 })).toMatchObject({ available: true, acceptedCount: 1 });
    expect((await f.memory.list()).total).toBe(0);
    await f.conversation("two");
    expect(await f.memory.learning!.list()).toEqual([]);
    expect((await f.memory.list()).items[0]).toMatchObject({ content: CONTENT, automaticManagement: "allowed",
      provenance: { kind: "passive_response", sourceSessionId: "chat", sourceRequestId: "two" } });
  });

  it("combines bound chat and screen evidence through the same candidate and policy", async () => {
    const f = fixture();
    await f.conversation("chat-one");
    const id = (await f.memory.learning!.list())[0]!.id;
    await f.observation("screen-two");
    expect((await f.memory.list()).items[0]).toMatchObject({ id, observationSources: [expect.objectContaining({ batchId: "screen-two" })] });
  });

  it("does not turn repeated text, rapid follow-ups, or a low score into permanent knowledge", async () => {
    const f = fixture();
    await f.conversation("first", { digest: "same evidence" });
    await f.conversation("rapid", { digest: "same evidence" });
    f.advance();
    await f.conversation("repeat", { digest: "same evidence" });
    expect((await f.memory.learning!.list())[0]!.reinforcements).toHaveLength(1);
    await f.conversation("second-independent", { score: 89 });
    expect((await f.memory.learning!.list())[0]!.reinforcements).toHaveLength(2);
    expect((await f.memory.list()).total).toBe(0);
  });

  it("keeps legacy unassessed proposals out of recall and reuses their request receipt", async () => {
    const f = fixture();
    const input = { candidates: [{ content: CONTENT, tags: [] }],
      context: { requestId: "old-request", sessionId: "chat", abortSignal: f.signal } };
    await f.memory.processCandidates(input);
    const before = await f.repository.read();
    f.embed.mockClear();
    await f.memory.processCandidates(input);
    expect(await f.repository.read()).toEqual(before);
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.memory.learning!.list())[0]).toMatchObject({ score: 0, reinforcements: [] });
    expect((await f.memory.retrieve({ query: CONTENT, context: input.context })).records).toEqual([]);
  });

  it("allows chat reinforcement while a Co-worker review deadline is overdue", async () => {
    const f = fixture();
    await f.observation("first", { reconsiderAt: "2026-09-25T11:00:00Z" });
    f.advance();
    expect(await f.conversation("second")).toMatchObject({ available: true, acceptedCount: 1 });
    expect((await f.memory.list()).items[0]).toMatchObject({ content: CONTENT, reconsiderAt: "2026-09-25T11:00:00Z" });
  });

  it("honors the canonical threshold even when another consumer supplies an older lower policy", async () => {
    const f = fixture();
    await f.memory.learning!.configurePolicy({ ...await f.memory.learning!.policy(), promotionScore: 98 });
    await f.conversation("first"); f.advance();
    await f.observation("second"); f.advance();
    await f.conversation("third");
    expect((await f.memory.list()).total).toBe(0);
    expect((await f.memory.learning!.policy()).promotionScore).toBe(98);
  });

  it("stages automatic rewrites and preserves a subsequent manual edit", async () => {
    const f = fixture();
    await f.conversation("one"); f.advance(); await f.conversation("two");
    const original = (await f.memory.list()).items[0]!;
    const target = (await f.memory.learning!.overview()).entries.find(entry => entry.kind === "memory")!;
    const content = "Now prefers detailed explanations with worked examples.";
    f.advance(); await f.conversation("rewrite-one", { target, content });
    expect((await f.memory.list()).items[0]!.content).toBe(CONTENT);
    const pending = (await f.memory.learning!.list())[0]!;
    expect(pending.replacement).toEqual({ id: original.id, version: original.updatedAt });
    await f.memory.update({ id: original.id, expectedUpdatedAt: original.updatedAt, content: "My own wording.",
      tags: [], context: { abortSignal: f.signal } });
    expect(await f.memory.learning!.list()).toEqual([]);
    f.advance(); await f.conversation("rewrite-two", { target, content }); f.advance(); await f.conversation("rewrite-three", { target, content });
    expect((await f.memory.list()).items[0]).toMatchObject({ content: "My own wording.", automaticManagement: "protected" });
    expect(await f.memory.learning!.list()).toEqual([]);
  });
});
