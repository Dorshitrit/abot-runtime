import { describe, expect, test, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type { LongTermMemoryRecord } from "../long-term-memory/contracts.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import type { LearningCandidateRecord, LearningMemoryDecision } from "../long-term-memory/maturation/contracts.js";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const FIRST = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
const SECOND = new Date(NOW - 12 * 60 * 60 * 1000).toISOString();

async function fixture() {
  const record: LongTermMemoryRecord = {
    id: "memory", content: "Prefers short answers.", tags: [], automaticManagement: "allowed",
    provenance: { kind: "passive_response", sourceRequestId: "original", sourceSessionId: "chat" },
    createdAt: FIRST, updatedAt: FIRST,
  };
  const candidate: LearningCandidateRecord = {
    id: "replacement", revision: 2, content: "Prefers detailed examples.", tags: [],
    score: 95, reason: "Repeated independent evidence", certainty: "observed",
    replacement: { id: record.id, version: record.updatedAt },
    sources: [FIRST, SECOND].map((observedAt, index) => ({
      kind: "passive_response" as const, sourceSessionId: "chat", sourceRequestId: `replacement-${index}`,
      observedAt, evidenceDigest: String(index + 1).repeat(64), reason: "Independent evidence", certainty: "observed" as const,
    })),
    reinforcements: [FIRST, SECOND].map((observedAt, index) => ({ key: String(index + 1).repeat(64), observedAt })),
    createdAt: FIRST, updatedAt: SECOND, lastReinforcedAt: SECOND,
    expiresAt: new Date(NOW + 30 * 86_400_000).toISOString(), reconsiderAt: null,
    embedding: { memoryId: "replacement", modelFingerprint: "test", dimensions: 2, vector: [1, 0] },
  };
  const repository = createInMemoryLongTermMemoryRepository({
    schemaVersion: 5, revision: 3, records: [record], learningCandidates: [candidate],
    vectors: [{ memoryId: record.id, modelFingerprint: "test", dimensions: 2, vector: [1, 0] }],
  });
  const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
    modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
  }));
  const memory = createLongTermMemoryService({ repository, embeddings: { embed }, enabled: true,
    emitClientEvents: false, now: () => new Date(NOW) });
  const signal = new AbortController().signal;
  const context = await memory.learning!.overview();
  const base = { tags: [], score: 95, reason: "Fresh independent evidence", certainty: "observed" as const,
    observationIds: ["fresh"], reinforced: true, mergedCandidateIds: [], reconsiderAt: null };
  const promote: LearningMemoryDecision = { ...base, action: "update", targetKind: "candidate",
    targetId: candidate.id, targetVersion: String(candidate.revision), content: candidate.content };
  const remove: LearningMemoryDecision = { ...base, action: "remove", targetKind: "memory",
    targetId: record.id, targetVersion: record.updatedAt, content: record.content };
  const apply = (decisions: readonly LearningMemoryDecision[]) => memory.learning!.apply({
    batchId: "review", batchExpiresAt: new Date(NOW + 86_400_000).toISOString(), environmentId: "dev",
    observations: [{ id: "fresh", deviceId: "pc", timestamp: new Date(NOW).toISOString() }],
    abortSignal: signal, context, decisions,
    policy: { promotionScore: 90, retentionDays: 30, maxCandidates: 500, maxBytes: 2 * 1024 * 1024 },
  });
  return { repository, memory, embed, promote, remove, apply };
}

describe("atomic replacement write targets", () => {
  test.each([false, true])("rejects a replacement and an explicit write to its memory, reversed: %s", async (reversed) => {
    const f = await fixture();
    const before = await f.repository.read();
    const decisions = [f.promote, f.remove];
    if (reversed) decisions.reverse();
    await expect(f.apply(decisions)).rejects.toThrow("learning_decision_target_repeated");
    expect(await f.repository.read()).toEqual(before);
    expect(f.embed).not.toHaveBeenCalled();
  });

  test("still promotes the fully matured replacement when it is the sole writer", async () => {
    const f = await fixture();
    await expect(f.apply([f.promote])).resolves.toMatchObject({ recordIds: ["memory"], candidateIds: [] });
    expect((await f.memory.list()).items[0]?.content).toBe(f.promote.content);
    expect(await f.memory.learning!.list()).toEqual([]);
  });
});
