import { describe, expect, test, vi } from "vitest";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { canAutomaticallyManageMemory } from "../long-term-memory/automatic-management.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { createLearningMemoryService } from "../long-term-memory/maturation/service.js";
import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRecord,
  LongTermMemoryRepository,
} from "../long-term-memory/contracts.js";
import {
  createManagedMemory,
  updateManagedMemory,
} from "../long-term-memory/management/mutations.js";
import { saveObservationMemoryBatch } from "../long-term-memory/observation-persistence.js";
import type { SaveObservationMemoryInput } from "../long-term-memory/observation-contracts.js";

const TIMESTAMP = "2026-09-25T10:00:00.000Z";
const now = () => new Date(TIMESTAMP);
const context = {
  requestId: "request",
  sessionId: "session",
  abortSignal: new AbortController().signal,
};

describe("automatic memory management protection", () => {
  test("unassessed automatic proposals from both consumers enter candidates only", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const content = "Prefers concise explanations.";
    await saveConversationDuplicate(repository, content);
    await saveObservationMemoryBatch({
      repository,
      learning: createLearningMemoryService({ repository, embeddings: embeddings(), now }),
      input: observationInput("Uses a separate workspace for research."),
      now,
    });
    const { records, learningCandidates } = await repository.read();
    expect(records).toEqual([]);
    expect(learningCandidates).toHaveLength(2);
    expect(learningCandidates?.every((candidate) => candidate.score === 0)).toBe(true);
  });

  test("manual creation is protected", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const result = await createManagedMemory({
      repository,
      embeddings: embeddings(),
      input: { content: "Prefers short answers.", tags: [], source: "web_ui", context },
      now,
    });
    expect(result.record.automaticManagement).toBe("protected");
    expect(canAutomaticallyManageMemory(result.record)).toBe(false);
  });

  test.each([false, true])("manual save protects automatic memory; text changed = %s", async (changeText) => {
    const original = automaticRecord();
    const repository = repositoryWith(original);
    const provider = embeddings();
    const result = await updateManagedMemory({
      repository,
      embeddings: provider,
      input: {
        id: original.id,
        expectedUpdatedAt: original.updatedAt,
        content: changeText ? "Prefers concise written explanations." : original.content,
        tags: original.tags,
        context,
      },
      now,
    });
    expect(result.updated).toBe(true);
    expect(result.record.provenance).toEqual(original.provenance);
    expect(result.record.automaticManagement).toBe("protected");
    expect(canAutomaticallyManageMemory(result.record)).toBe(false);
    expect(provider.embed).toHaveBeenCalledTimes(changeText ? 1 : 0);
    const unchanged = await updateManagedMemory({
      repository,
      embeddings: provider,
      input: { ...result.record, expectedUpdatedAt: result.record.updatedAt, context },
      now,
    });
    expect(unchanged.updated).toBe(false);
  });

  test.each(["legacy", "manual", "edited"] as const)("%s record is never changed by automatic duplicate writes", async (kind) => {
    const original = protectedRecord(kind);
    const repository = repositoryWith(original);
    const provider = embeddings();
    expect(canAutomaticallyManageMemory(original)).toBe(false);
    await saveConversationDuplicate(repository, original.content);
    const receipt = await saveObservationMemoryBatch({
      repository, learning: createLearningMemoryService({ repository, embeddings: provider, now }), input: observationInput(original.content), now,
    });
    expect((await repository.read()).records).toEqual([original]);
    expect(receipt.recordIds).toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  test("unassessed duplicates leave existing automatic memories unchanged", async () => {
    const original = automaticRecord();
    const repository = repositoryWith(original);
    const provider = embeddings();
    await saveConversationDuplicate(repository, original.content);
    const receipt = await saveObservationMemoryBatch({
      repository, learning: createLearningMemoryService({ repository, embeddings: provider, now }), input: observationInput(original.content), now,
    });
    const updated = (await repository.read()).records[0]!;
    expect(updated).toEqual(original);
    expect(receipt.recordIds).toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();
  });

  test("manual protection committed during observation preparation wins", async () => {
    const original = automaticRecord();
    const repository = repositoryWith(original);
    const provider = embeddings();
    const input = observationInput(original.content);
    provider.embed.mockImplementationOnce(async ({ texts }) => {
      await updateManagedMemory({
        repository, embeddings: embeddings(), now,
        input: { ...original, tags: ["manually-reviewed"], expectedUpdatedAt: original.updatedAt, context },
      });
      return { modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]) };
    });
    const receipt = await saveObservationMemoryBatch({
      repository, learning: createLearningMemoryService({ repository, embeddings: provider, now }), now,
      input: { ...input, proposals: [...input.proposals,
        { ...input.proposals[0]!, content: "Uses a separate research workspace." }] },
    });
    const target = (await repository.read()).records.find((record) => record.id === original.id)!;
    expect(target.automaticManagement).toBe("protected");
    expect(target.tags).toEqual(["manually-reviewed"]);
    expect(target.observationSources).toBeUndefined();
    expect(receipt.recordIds).toEqual([]);
    expect(receipt.candidateIds).toHaveLength(1);
  });
});

function automaticRecord(): LongTermMemoryRecord {
  return {
    id: "memory", content: "Prefers concise explanations.", tags: ["preference"],
    provenance: { kind: "passive_response", sourceSessionId: "session", sourceRequestId: "request" },
    automaticManagement: "allowed", createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
  };
}

function protectedRecord(kind: "legacy" | "manual" | "edited"): LongTermMemoryRecord {
  const record = automaticRecord();
  if (kind === "manual")
    return { ...record, provenance: { kind: "manual", source: "web_ui" } };
  if (kind === "edited") return { ...record, automaticManagement: "protected" };
  const { automaticManagement: _unknownLegacyHistory, ...legacy } = record;
  return legacy;
}

function repositoryWith(record: LongTermMemoryRecord): LongTermMemoryRepository {
  return createInMemoryLongTermMemoryRepository({
    schemaVersion: 1, revision: 0, records: [record],
    vectors: [{ memoryId: record.id, modelFingerprint: "test", dimensions: 2, vector: [1, 0] }],
  });
}

function embeddings() {
  return { embed: vi.fn<LongTermMemoryEmbeddingClient["embed"]>(async ({ texts }) => ({
    modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]),
  })) };
}

function saveConversationDuplicate(repository: LongTermMemoryRepository, content: string) {
  const memory = createLongTermMemoryService({ repository, embeddings: embeddings(), enabled: true, emitClientEvents: false, now });
  return memory.processCandidates({ candidates: [{ content, tags: ["reinforced"] }], context });
}

function observationInput(content: string): SaveObservationMemoryInput {
  return {
    batchId: "batch", batchExpiresAt: "2026-09-26T10:00:00.000Z",
    environmentId: "environment", abortSignal: context.abortSignal,
    observations: [{ id: "observation", deviceId: "computer", timestamp: TIMESTAMP }],
    proposals: [{ content, tags: ["workflow"], observationIds: ["observation"],
      reason: "Observed independent activity.", certainty: "observed" }],
  };
}
