import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type { LongTermMemoryService, MemoryCandidate } from "../long-term-memory/contracts.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";

const services: LongTermMemoryService[] = [];
afterEach(async () => {
  for (const memory of services.splice(0)) await memory.retention?.stop();
});

async function fixture() {
  const now = new Date("2026-09-26T12:00:00Z");
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
    modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
  }));
  const memory = createLongTermMemoryService({ repository, embeddings: { embed }, enabled: true,
    emitClientEvents: false, now: () => now });
  services.push(memory);
  const context = { requestId: "explicit-request", sessionId: "session", abortSignal: new AbortController().signal };
  await memory.processCandidates({ context: { ...context, requestId: "earlier-request" },
    candidates: [{ content: "May prefer concise explanations.", tags: [] }] });
  const target = (await memory.learning!.overview()).entries[0]!;
  const proposal: MemoryCandidate = { content: "Prefers short explanations with examples.", tags: [], assessment: {
    target, explicitlyRequested: true, score: 90, reason: "Direct user request", reinforced: true,
    evidence: { sourceSessionId: context.sessionId, sourceRequestId: context.requestId,
      observedAt: now.toISOString(), evidenceDigest: "e".repeat(64) },
  } };
  return { repository, memory, embed, context, target, proposal };
}

describe("explicit memory candidate supersession", () => {
  it("commits revised explicit wording and consumes its bound candidate together", async () => {
    const f = await fixture();
    const result = await f.memory.processCandidates({ candidates: [f.proposal], context: f.context });
    expect(result).toMatchObject({ available: true, acceptedCount: 1 });
    const snapshot = await f.repository.read();
    expect(snapshot.learningCandidates).toEqual([]);
    expect(snapshot.records).toMatchObject([{ content: f.proposal.content, automaticManagement: "protected",
      provenance: { kind: "manual", source: "management_api" } }]);
  });

  it.each(["allowed", "protected"] as const)("consumes the candidate when the new wording matches an existing %s memory", async (automaticManagement) => {
    const f = await fixture();
    const created = await f.memory.create({ content: f.proposal.content, tags: [], source: "web_ui", context: f.context });
    await f.repository.update((current) => ({ ...current, records: current.records.map((record) => ({ ...record, automaticManagement })) }));
    const result = await f.memory.processCandidates({ candidates: [f.proposal], context: f.context });
    expect(result).toMatchObject({ available: true, acceptedCount: 1 });
    const snapshot = await f.repository.read();
    expect(snapshot.learningCandidates).toEqual([]);
    expect(snapshot.records).toMatchObject([{ id: created.record.id, automaticManagement: "protected" }]);
    expect(snapshot.records).toHaveLength(1);
  });

  it.each(["revised", "removed"])("rejects a candidate %s during embedding without committing the new memory", async (change) => {
    const f = await fixture();
    const embed = f.embed.getMockImplementation()!;
    f.embed.mockImplementationOnce(async (input) => {
      await f.repository.update((current) => ({ ...current, learningCandidates: change === "removed" ? []
        : current.learningCandidates!.map((candidate) => ({ ...candidate, revision: candidate.revision + 1 })) }));
      return embed(input);
    });
    const result = await f.memory.processCandidates({ candidates: [f.proposal], context: f.context });
    expect(result).toMatchObject({ available: false, acceptedCount: 0 });
    const snapshot = await f.repository.read();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.learningCandidates).toHaveLength(change === "removed" ? 0 : 1);
  });

  it("preserves the candidate when embedding fails", async () => {
    const f = await fixture();
    const before = await f.repository.read();
    f.embed.mockRejectedValueOnce(new Error("embedding unavailable"));
    const result = await f.memory.processCandidates({ candidates: [f.proposal], context: f.context });
    expect(result).toMatchObject({ available: false, acceptedCount: 0 });
    expect(await f.repository.read()).toEqual(before);
  });
});
