import { expect, test, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemoryManagement } from "../long-term-memory/management/service.js";
import type { LearningCandidateRecord } from "../long-term-memory/maturation/contracts.js";
import type { LongTermMemoryRecord, LongTermMemoryRepository } from "../long-term-memory/contracts.js";

const timestamp = "2026-11-02T10:00:00.000Z";
const memory = (): LongTermMemoryRecord => ({ id: "saved", content: "Prefers coffee.", tags: [],
  provenance: { kind: "manual", source: "web_ui" }, automaticManagement: "protected", createdAt: timestamp, updatedAt: timestamp });
const candidate = (changes: Partial<LearningCandidateRecord> = {}): LearningCandidateRecord => ({
  id: "candidate", revision: 2, content: "Prefers tea.", tags: ["preference"], score: 25,
  reason: "Tentative preference", certainty: "inferred", sources: [], createdAt: timestamp, updatedAt: timestamp,
  lastReinforcedAt: timestamp, expiresAt: "2099-11-02T10:00:00.000Z", reconsiderAt: null,
  embedding: { memoryId: "candidate", modelFingerprint: "fixture", dimensions: 2, vector: [1, 0] }, ...changes,
});
const request = (revision = 2) => ({ id: "candidate", revision, source: "web_ui" as const,
  context: { abortSignal: new AbortController().signal } });

async function fixture(changes: Partial<LearningCandidateRecord> = {}, record?: LongTermMemoryRecord) {
  const repository = createInMemoryLongTermMemoryRepository();
  await repository.update(current => ({ ...current, learningCandidates: [candidate(changes)], records: record ? [record] : [],
    vectors: record ? [{ memoryId: record.id, modelFingerprint: "fixture", dimensions: 2, vector: [1, 0] }] : [] }));
  const embed = vi.fn(async () => ({ modelFingerprint: "fixture", dimensions: 2, vectors: [[1, 0]] }));
  const options = { repository, enabled: true, embeddings: { embed }, now: () => new Date("2026-11-02T11:00:00.000Z"), createId: () => "approved" };
  return { repository, embed, options, service: createLongTermMemoryManagement(options) };
}

test("explicit approval atomically saves a protected manual memory without changing automatic promotion thresholds", async () => {
  const f = await fixture();
  const approved = await f.service.promoteCandidate!(request());
  expect(approved.record).toMatchObject({ id: "approved", content: "Prefers tea.", tags: ["preference"],
    provenance: { kind: "manual", source: "web_ui" }, automaticManagement: "protected" });
  const saved = await f.repository.read();
  expect(saved.learningCandidates).toEqual([]);
  expect(saved.records).toEqual([approved.record]);
  expect(saved.vectors.map(value => value.memoryId)).toEqual(["approved"]);
  expect(f.embed).toHaveBeenCalledOnce();
});

test("replacement approval updates only the version bound by that candidate and protects the memory", async () => {
  const f = await fixture({ replacement: { id: "saved", version: timestamp } }, memory());
  const approved = await f.service.promoteCandidate!(request());
  expect(approved.record).toMatchObject({ id: "saved", content: "Prefers tea.", automaticManagement: "protected", createdAt: timestamp });
  expect((await f.repository.read()).records).toHaveLength(1);
  expect((await f.repository.read()).learningCandidates).toEqual([]);
});

test("a stale candidate or replacement is rejected before embedding", async () => {
  const f = await fixture({ replacement: { id: "saved", version: timestamp } }, { ...memory(), updatedAt: "2026-11-02T10:30:00.000Z" });
  const before = await f.repository.read();
  await expect(f.service.promoteCandidate!(request(1))).rejects.toMatchObject({ code: "long_term_memory_management_conflict" });
  await expect(f.service.promoteCandidate!(request())).rejects.toMatchObject({ code: "long_term_memory_management_conflict" });
  expect(f.embed).not.toHaveBeenCalled();
  expect(await f.repository.read()).toEqual(before);
});

test("a candidate changed during embedding cannot be removed by the old approval", async () => {
  const f = await fixture();
  f.embed.mockImplementationOnce(async () => {
    await f.repository.update(current => ({ ...current, learningCandidates: [candidate({ revision: 3, content: "New candidate text." })] }));
    return { modelFingerprint: "fixture", dimensions: 2, vectors: [[1, 0]] };
  });
  await expect(f.service.promoteCandidate!(request())).rejects.toMatchObject({ code: "long_term_memory_management_conflict" });
  expect((await f.repository.read()).records).toEqual([]);
  expect((await f.repository.read()).learningCandidates).toMatchObject([{ revision: 3, content: "New candidate text." }]);
});

test("duplicate saved content leaves the candidate intact without embedding", async () => {
  const f = await fixture({}, { ...memory(), content: "Prefers tea." });
  const before = await f.repository.read();
  await expect(f.service.promoteCandidate!(request())).rejects.toMatchObject({ code: "long_term_memory_management_duplicate" });
  expect(f.embed).not.toHaveBeenCalled();
  expect(await f.repository.read()).toEqual(before);
});

test("delete is exact-revision-bound, remains available while memory is disabled, and preserves saved records", async () => {
  const f = await fixture({}, memory());
  const disabled = createLongTermMemoryManagement({ repository: f.repository, enabled: false });
  const before = await f.repository.read();
  await expect(disabled.deleteCandidate!({ id: "candidate", revision: 1 })).rejects.toMatchObject({ code: "long_term_memory_management_conflict" });
  expect(await f.repository.read()).toEqual(before);
  await expect(disabled.deleteCandidate!({ id: "candidate", revision: 2 })).resolves.toEqual({ deleted: true });
  const after = await f.repository.read();
  expect(after.learningCandidates).toEqual([]);
  expect(after.records).toEqual(before.records);
  expect(after.vectors).toEqual(before.vectors);
  await expect(disabled.deleteCandidate!({ id: "candidate", revision: 2 })).rejects.toMatchObject({ code: "long_term_memory_management_not_found" });
  expect(f.embed).not.toHaveBeenCalled();
});

test("failed publication preserves the candidate and returns no success", async () => {
  const f = await fixture();
  const before = await f.repository.read();
  const repository: LongTermMemoryRepository = { read: () => f.repository.read(), update: async () => { throw new Error("storage_failed"); } };
  const service = createLongTermMemoryManagement({ ...f.options, repository });
  await expect(service.promoteCandidate!(request())).rejects.toMatchObject({ code: "long_term_memory_unavailable" });
  await expect(service.deleteCandidate!({ id: "candidate", revision: 2 })).rejects.toMatchObject({ code: "long_term_memory_unavailable" });
  expect(await f.repository.read()).toEqual(before);
});

test("cancelled promotion preserves both the candidate and original abort reason", async () => {
  const f = await fixture();
  const before = await f.repository.read();
  const abort = new AbortController();
  const reason = new Error("user_cancelled");
  f.embed.mockImplementationOnce(async () => {
    abort.abort(reason);
    return { modelFingerprint: "fixture", dimensions: 2, vectors: [[1, 0]] };
  });
  await expect(f.service.promoteCandidate!({ ...request(), context: { abortSignal: abort.signal } })).rejects.toBe(reason);
  expect(await f.repository.read()).toEqual(before);
});

test.each([0, -1, 1.5, NaN])("rejects invalid candidate revision %s before mutation", async revision => {
  const f = await fixture();
  const before = await f.repository.read();
  await expect(f.service.promoteCandidate!(request(revision))).rejects.toMatchObject({ code: "long_term_memory_management_input_invalid" });
  await expect(f.service.deleteCandidate!({ id: "candidate", revision })).rejects.toMatchObject({ code: "long_term_memory_management_input_invalid" });
  expect(f.embed).not.toHaveBeenCalled();
  expect(await f.repository.read()).toEqual(before);
});
