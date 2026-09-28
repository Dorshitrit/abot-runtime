import { describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { parseMemorySnapshot } from "../long-term-memory/repository-state.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";
import { projectLearningMaturationPreferences, commitLearningMaturationPreferences } from "../passive-learning/maturation-preferences.js";
import { DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";

function fixture() {
  const repository = createInMemoryLongTermMemoryRepository();
  const embed = vi.fn();
  const memory = createLongTermMemoryService({ repository, embeddings: { embed }, enabled: true, emitClientEvents: false });
  return { repository, memory, embed };
}

describe("shared automatic memory admission policy", () => {
  it("imports legacy preferences once and preserves the chosen score in the canonical policy", async () => {
    const f = fixture();
    const legacy = { ...DEFAULT_LEARNING_PREFERENCES, maturation: { ...DEFAULT_MATURATION_POLICY, promotionScore: 80, retentionDays: 21 } };
    const imported = await projectLearningMaturationPreferences(f.memory, legacy, true);
    expect(imported.maturation).toMatchObject({ promotionScore: 80, retentionDays: 21 });
    expect(await f.memory.learning!.policy()).toEqual(imported.maturation);
    const initial = await f.repository.read();
    expect(initial.schemaVersion).toBe(5);
    await projectLearningMaturationPreferences(f.memory, { ...legacy, maturation: { ...legacy.maturation, retentionDays: 10 } }, true);
    expect(await f.repository.read()).toEqual({ ...initial, revision: initial.revision + 1 });
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("projects explicit shared settings while collection is off and ignores stale caches", async () => {
    const f = fixture();
    const requested = { ...DEFAULT_MATURATION_POLICY, promotionScore: 0 };
    const committed = await commitLearningMaturationPreferences(f.memory, DEFAULT_LEARNING_PREFERENCES, { maturation: requested },
      { previous: DEFAULT_LEARNING_PREFERENCES, persist: vi.fn().mockResolvedValue(undefined) });
    expect(committed.enabled).toBe(false);
    expect(committed.maturation).toEqual(requested);
    const projected = await projectLearningMaturationPreferences(f.memory, DEFAULT_LEARNING_PREFERENCES);
    expect(projected.maturation).toEqual(requested);
    const current = await f.repository.read();
    expect(parseMemorySnapshot(JSON.parse(JSON.stringify(current)))).toEqual(current);
    await f.memory.learning!.configurePolicy(requested);
    expect(await f.repository.read()).toEqual({ ...current, revision: current.revision + 1 });
  });

  it("preserves collection controls during a repository outage but rejects explicit policy saves", async () => {
    const f = fixture();
    const broken = { ...f.memory, learning: { ...f.memory.learning!, policy: vi.fn().mockRejectedValue(new Error("unavailable")),
      configurePolicy: vi.fn().mockRejectedValue(new Error("unavailable")) } };
    const projected = await projectLearningMaturationPreferences(broken, { ...DEFAULT_LEARNING_PREFERENCES, enabled: true }, true);
    expect(projected.enabled).toBe(true);
    await expect(commitLearningMaturationPreferences(broken, projected, { maturation: DEFAULT_MATURATION_POLICY },
      { previous: projected, persist: vi.fn().mockResolvedValue(undefined) })).rejects.toThrow("unavailable");
  });

  it("roundtrips conversation evidence, rejects malformed proofs and never fabricates legacy proof", () => {
    const timestamp = "2026-09-26T10:00:00.000Z";
    const candidate = { id: "candidate", revision: 1, content: "Prefers concise reports.", tags: [], score: 95,
      reason: "Repeated preference.", certainty: "observed", sources: [{ kind: "passive_response",
        sourceSessionId: "session", sourceRequestId: "request", evidenceDigest: "a".repeat(64), observedAt: timestamp,
        reason: "Repeated preference.", certainty: "observed" }], reinforcements: [{ key: "b".repeat(64), observedAt: timestamp }],
      createdAt: timestamp, updatedAt: timestamp, lastReinforcedAt: timestamp, expiresAt: "2026-10-26T10:00:00.000Z",
      reconsiderAt: null, embedding: { memoryId: "candidate", dimensions: 2, modelFingerprint: "test", vector: [1, 0] } };
    const snapshot = { schemaVersion: 5, revision: 1, records: [], vectors: [], learningCandidates: [candidate] };
    expect(parseMemorySnapshot(snapshot).learningCandidates).toEqual([candidate]);
    expect(() => parseMemorySnapshot({ ...snapshot, learningCandidates: [{ ...candidate, reinforcements: [{ key: "bad", observedAt: timestamp }] }] })).toThrow();
    const observation = { kind: "passive_observation", environmentId: "dev", deviceId: "device", batchId: "batch",
      observationIds: ["one", "two", "three"], observedAt: timestamp, reason: "Observed.", certainty: "observed" };
    const legacy = parseMemorySnapshot({ ...snapshot, schemaVersion: 4, learningCandidates: [{ ...candidate, sources: [observation] }] });
    expect(legacy.learningCandidates![0]).not.toHaveProperty("reinforcements");
    expect(() => parseMemorySnapshot({ ...snapshot, learningCandidates: [{ ...candidate, sources: [{ kind: "unknown" }], reinforcements: [] }] })).toThrow();
    expect(parseMemorySnapshot({ ...snapshot, learningCandidates: [{ ...candidate, sources: [], reinforcements: [],
      replacement: { id: "memory", version: timestamp } }] }).learningCandidates![0]!.sources).toEqual([]);
  });
});
