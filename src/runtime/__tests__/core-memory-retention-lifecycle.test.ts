import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningCandidateRecord } from "../long-term-memory/maturation/contracts.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";

const DAY = 86_400_000;
const services: LongTermMemoryService[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-26T10:00:00Z")); });
afterEach(async () => {
  for (const memory of services.splice(0)) await memory.retention?.stop();
  vi.useRealTimers();
});

function candidate(expiresAt: number): LearningCandidateRecord {
  const timestamp = new Date().toISOString();
  return { id: "candidate", revision: 1, content: "Prefers short reports.", tags: [],
    score: 95, reason: "Lasting preference.", certainty: "observed", sources: [],
    createdAt: timestamp, updatedAt: timestamp, lastReinforcedAt: timestamp,
    expiresAt: new Date(expiresAt).toISOString(), reconsiderAt: null,
    embedding: { memoryId: "candidate", modelFingerprint: "test", dimensions: 2, vector: [1, 0] } };
}

function fixture(initial: readonly LearningCandidateRecord[] = [], enabled = true) {
  const base = createInMemoryLongTermMemoryRepository({ schemaVersion: 5, revision: 0, records: [], vectors: [],
    learningCandidates: initial, maturationPolicy: DEFAULT_MATURATION_POLICY });
  const repository = { read: vi.fn(base.read), update: vi.fn(base.update) };
  const embed = vi.fn(async (input: { texts: readonly string[] }) => ({ modelFingerprint: "test", dimensions: 2,
    vectors: input.texts.map(() => [1, 0]) }));
  const memory = createLongTermMemoryService({ repository, enabled, emitClientEvents: false,
    ...(enabled ? { embeddings: { embed } } : {}) });
  services.push(memory);
  return { repository, memory, embed };
}

describe("core memory retention ownership", () => {
  it("expires standalone conversation candidates without a Co-worker or explicit start", async () => {
    const f = fixture();
    const result = await f.memory.processCandidates({ candidates: [{ content: "Prefers short reports.", tags: [] }],
      context: { requestId: "request", sessionId: "session", abortSignal: new AbortController().signal } });
    expect(result.acceptedCount).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    expect((await f.repository.read()).learningCandidates).toHaveLength(1);
    f.embed.mockClear();
    await vi.advanceTimersByTimeAsync(30 * DAY);
    expect(await f.repository.read()).toMatchObject({ learningCandidates: [], learningReceipts: [] });
    expect(f.embed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does no repeated reads, writes, timer or provider work when empty", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    const reads = f.repository.read.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(31 * DAY);
    expect(f.repository.read).toHaveBeenCalledTimes(reads);
    expect(f.repository.update).not.toHaveBeenCalled();
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("cleans loaded state with memory disabled and no embedding provider", async () => {
    const f = fixture([candidate(Date.now() + 1000)], false);
    await vi.advanceTimersByTimeAsync(999);
    expect((await f.repository.read()).learningCandidates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.repository.read()).learningCandidates).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms after receipt-only commits without emitting a knowledge change", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    const changed = vi.fn();
    f.memory.subscribeChanges!(changed);
    await f.memory.learning!.apply({ batchId: "empty-review", environmentId: "dev", observations: [], decisions: [],
      batchExpiresAt: new Date(Date.now() + 1000).toISOString(), policy: DEFAULT_MATURATION_POLICY,
      abortSignal: new AbortController().signal, context: { kind: "learning_knowledge_reference_v1",
        authority: "passive_reference", presenceEffect: "does_not_authorize_actions_or_add_user_intent",
        repositoryRevision: 0, knowledgeRevision: 0, referenceTime: new Date().toISOString(), entries: [], omitted: 0 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await f.repository.read()).learningReceipts).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("removes already expired loaded candidates at creation without a provider", async () => {
    const f = fixture([candidate(Date.now() - 1000)], false);
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.repository.read()).learningCandidates).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces shorter canonical retention when only the policy changes", async () => {
    const f = fixture([candidate(Date.now() + 30 * DAY)]);
    await vi.advanceTimersByTimeAsync(2 * DAY);
    const changed = vi.fn();
    f.memory.subscribeChanges!(changed);
    await f.memory.learning!.configurePolicy({ ...DEFAULT_MATURATION_POLICY, retentionDays: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.repository.read()).learningCandidates).toEqual([]);
    expect(changed).toHaveBeenCalledOnce();
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("detaches and clears its timer on stop, and cleans overdue state on restart", async () => {
    const f = fixture([candidate(Date.now() + 1000)]);
    await vi.advanceTimersByTimeAsync(0);
    await f.memory.retention!.stop();
    expect(vi.getTimerCount()).toBe(0);
    await f.memory.learning!.configurePolicy({ ...DEFAULT_MATURATION_POLICY, retentionDays: 10 });
    const afterPolicy = f.repository.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.repository.read).toHaveBeenCalledTimes(afterPolicy);
    expect((await f.repository.read()).learningCandidates).toHaveLength(1);
    await f.memory.retention!.start();
    expect((await f.repository.read()).learningCandidates).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports one storage failure without polling and recovers on restart", async () => {
    const f = fixture([candidate(Date.now() + 1000)]);
    await vi.advanceTimersByTimeAsync(0);
    const changed = vi.fn();
    f.memory.retention!.subscribeChanges(changed);
    f.repository.update.mockRejectedValueOnce(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.memory.retention!.reason()).toBe("learning_maintenance_failed");
    expect(changed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(f.repository.update).toHaveBeenCalledOnce();
    await f.memory.retention!.stop();
    await f.memory.retention!.start();
    expect(f.memory.retention!.reason()).toBeUndefined();
    expect((await f.repository.read()).learningCandidates).toEqual([]);
  });
});
