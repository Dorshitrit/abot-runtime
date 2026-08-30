import { describe, expect, test, vi } from "vitest";

import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRecord,
  LongTermMemoryRequestContext,
} from "../long-term-memory/contracts.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";

const REQUEST_CONTEXT: LongTermMemoryRequestContext = {
  requestId: "request-memory",
  sessionId: "session-memory",
  abortSignal: new AbortController().signal,
};

describe("passive long-term memory", () => {
  test("keeps the disabled path free of repository and embedding work", async () => {
    const repository = {
      read: vi.fn(),
      update: vi.fn(),
    };
    const embeddings = { embed: vi.fn() };
    const service = createLongTermMemoryService({
      repository,
      embeddings,
      enabled: false,
      emitClientEvents: false,
    });

    await expect(
      service.retrieve({ query: "anything", context: REQUEST_CONTEXT }),
    ).resolves.toMatchObject({ available: false, reason: "disabled" });
    await expect(
      service.processCandidates({
        candidates: [{ content: "Remember this", tags: ["preference"] }],
        context: REQUEST_CONTEXT,
      }),
    ).resolves.toMatchObject({ available: false, reason: "disabled" });
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  test("retrieves a relevant memory across languages and rejects an unrelated query", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const embeddings = createSemanticFixtureEmbeddings();
    const service = createLongTermMemoryService({
      repository,
      embeddings,
      enabled: true,
      emitClientEvents: false,
      now: () => new Date("2026-08-26T08:00:00.000Z"),
      createId: () => "memory-coffee",
    });
    await service.processCandidates({
      candidates: [
        {
          content: "The user prefers coffee without sugar.",
          tags: ["coffee", "preference"],
        },
      ],
      context: REQUEST_CONTEXT,
    });

    const relevant = await service.retrieve({
      query: "איך אני אוהב את הקפה שלי?",
      context: { ...REQUEST_CONTEXT, sessionId: "different-session" },
    });
    const unrelated = await service.retrieve({
      query: "What is the weather in London?",
      context: REQUEST_CONTEXT,
    });

    expect(relevant.records.map(({ id }) => id)).toEqual(["memory-coffee"]);
    expect(relevant.message?.content).toContain(
      "The user prefers coffee without sugar.",
    );
    expect(unrelated.records).toEqual([]);
    expect(unrelated.message).toBeUndefined();
  });

  test("filters secrets and mechanically merges exact duplicates", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const service = createLongTermMemoryService({
      repository,
      embeddings: createSemanticFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      now: () => new Date("2026-08-26T08:00:00.000Z"),
      createId: () => "memory-one",
    });
    const result = await service.processCandidates({
      candidates: [
        { content: " User prefers dark mode. ", tags: ["UX"] },
        { content: "User prefers dark mode.", tags: ["preference"] },
        { content: "api_key=sk-abcdefghijklmnopqrstuvwxyz", tags: ["secret"] },
        {
          content: "User prefers compact navigation.",
          tags: ["api_key=sk-abcdefghijklmnopqrstuvwxyz"],
        },
      ],
      context: REQUEST_CONTEXT,
    });
    const listed = await service.list();

    expect(result).toMatchObject({
      acceptedCount: 1,
      rejectedCount: 2,
      duplicateCount: 1,
    });
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({
      id: "memory-one",
      content: "User prefers dark mode.",
      tags: ["ux", "preference"],
      provenance: {
        kind: "passive_response",
        sourceSessionId: "session-memory",
        sourceRequestId: "request-memory",
      },
    });
  });

  test("reindexes canonical records after an embedding fingerprint change", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const original = createSemanticFixtureEmbeddings("fingerprint-v1");
    const service = createLongTermMemoryService({
      repository,
      embeddings: original,
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-reindex",
    });
    await service.processCandidates({
      candidates: [{ content: "User prefers coffee.", tags: ["coffee"] }],
      context: REQUEST_CONTEXT,
    });
    const replacement = createSemanticFixtureEmbeddings("fingerprint-v2");
    const reloaded = createLongTermMemoryService({
      repository,
      embeddings: replacement,
      enabled: true,
      emitClientEvents: false,
    });

    await reloaded.retrieve({
      query: "קפה",
      context: REQUEST_CONTEXT,
    });
    const snapshot = await repository.read();

    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.vectors).toHaveLength(1);
    expect(snapshot.vectors[0]?.modelFingerprint).toBe("fingerprint-v2");
  });

  test("reindexes records in batches within the embedding client limit", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const records = Array.from({ length: 129 }, (_, index) =>
      createFixtureRecord(index),
    );
    await repository.update((current) => ({
      records,
      vectors: current.vectors,
    }));
    const embed = vi.fn(async (input: { texts: readonly string[] }) => ({
      modelFingerprint: "fingerprint-current",
      dimensions: 2,
      vectors: input.texts.map(() => Object.freeze([1, 0])),
    }));
    const service = createLongTermMemoryService({
      repository,
      embeddings: { maxBatchSize: 128, embed },
      enabled: true,
      emitClientEvents: false,
    });

    await service.retrieve({ query: "fixture", context: REQUEST_CONTEXT });

    expect(embed.mock.calls.map(([input]) => input.texts.length)).toEqual([
      1, 128, 1,
    ]);
    expect((await repository.read()).vectors).toHaveLength(129);
  });

  test("saves candidate embeddings in provider-sized batches", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const embed = vi.fn(async (input: { texts: readonly string[] }) => ({
      modelFingerprint: "fingerprint-current",
      dimensions: 2,
      vectors: input.texts.map(() => Object.freeze([1, 0])),
    }));
    let nextId = 0;
    const service = createLongTermMemoryService({
      repository,
      embeddings: { maxBatchSize: 128, embed },
      enabled: true,
      emitClientEvents: false,
      createId: () => `memory-candidate-${nextId++}`,
    });

    await expect(
      service.processCandidates({
        candidates: Array.from({ length: 129 }, (_, index) => ({
          content: `Durable preference ${index}.`,
          tags: ["fixture"],
        })),
        context: REQUEST_CONTEXT,
      }),
    ).resolves.toMatchObject({ acceptedCount: 129 });

    expect(embed.mock.calls.map(([input]) => input.texts.length)).toEqual([
      128, 1,
    ]);
    expect((await repository.read()).records).toHaveLength(129);
  });

  test("does not replace a concurrent record update with a stale reindex vector", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const originalRecord = createFixtureRecord(0);
    await repository.update(() => ({
      records: [originalRecord],
      vectors: [],
    }));
    let embedCall = 0;
    const embed = vi.fn(async () => {
      embedCall += 1;
      if (embedCall === 1) {
        return {
          modelFingerprint: "fingerprint-current",
          dimensions: 2,
          vectors: [Object.freeze([1, 0])],
        };
      }
      await repository.update((current) => ({
        records: current.records.map((record) =>
          Object.freeze({
            ...record,
            content: "Concurrent updated memory.",
            updatedAt: "2026-08-26T01:00:00.000Z",
          }),
        ),
        vectors: [
          Object.freeze({
            memoryId: originalRecord.id,
            modelFingerprint: "fingerprint-current",
            dimensions: 2,
            vector: Object.freeze([0, 1]),
          }),
        ],
      }));
      return {
        modelFingerprint: "fingerprint-current",
        dimensions: 2,
        vectors: [Object.freeze([1, 0])],
      };
    });
    const service = createLongTermMemoryService({
      repository,
      embeddings: { embed },
      enabled: true,
      emitClientEvents: false,
    });

    await service.retrieve({ query: "fixture", context: REQUEST_CONTEXT });

    const snapshot = await repository.read();
    expect(snapshot.records[0]?.content).toBe("Concurrent updated memory.");
    expect(snapshot.vectors).toEqual([
      expect.objectContaining({
        memoryId: originalRecord.id,
        vector: [0, 1],
      }),
    ]);
  });

  test("keeps a concurrent tag-only update during vector reindexing", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const originalRecord = createFixtureRecord(0);
    await repository.update(() => ({
      records: [originalRecord],
      vectors: [
        Object.freeze({
          memoryId: originalRecord.id,
          modelFingerprint: "fingerprint-previous",
          dimensions: 2,
          vector: Object.freeze([0, 1]),
        }),
      ],
    }));
    let embedCall = 0;
    const embed = vi.fn(async () => {
      embedCall += 1;
      if (embedCall === 2) {
        await repository.update((current) => ({
          records: current.records.map((record) =>
            Object.freeze({
              ...record,
              tags: Object.freeze([...record.tags, "updated"]),
              updatedAt: "2026-08-26T01:00:00.000Z",
            }),
          ),
          vectors: current.vectors,
        }));
      }
      return {
        modelFingerprint: "fingerprint-current",
        dimensions: 2,
        vectors: [Object.freeze([1, 0])],
      };
    });
    const service = createLongTermMemoryService({
      repository,
      embeddings: { embed },
      enabled: true,
      emitClientEvents: false,
    });

    const result = await service.retrieve({
      query: "fixture",
      context: REQUEST_CONTEXT,
    });

    expect(result.records).toEqual([
      expect.objectContaining({
        id: originalRecord.id,
        tags: ["fixture", "updated"],
      }),
    ]);
    expect((await repository.read()).vectors).toEqual([
      expect.objectContaining({
        memoryId: originalRecord.id,
        modelFingerprint: "fingerprint-current",
        vector: [1, 0],
      }),
    ]);
  });

  test("keeps candidate-processing outcomes diagnostic-only", async () => {
    const onEvent = vi.fn();
    const service = createLongTermMemoryService({
      repository: createInMemoryLongTermMemoryRepository(),
      embeddings: createSemanticFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: true,
      createId: () => "memory-event",
    });
    await service.processCandidates({
      candidates: [{ content: "User prefers coffee.", tags: ["coffee"] }],
      context: { ...REQUEST_CONTEXT, onEvent },
    });

    expect(onEvent).not.toHaveBeenCalled();
  });

  test("reports the committed winner and duplicate under concurrent saves", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    let started = 0;
    let releaseEmbeddings!: () => void;
    let bothStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEmbeddings = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const service = createLongTermMemoryService({
      repository,
      embeddings: {
        async embed() {
          started += 1;
          if (started === 2) bothStarted();
          await gate;
          return {
            modelFingerprint: "concurrent-save",
            dimensions: 2,
            vectors: [[1, 0]],
          };
        },
      },
      enabled: true,
      emitClientEvents: false,
    });
    const save = () =>
      service.processCandidates({
        candidates: [{ content: "Shared memory.", tags: ["shared"] }],
        context: REQUEST_CONTEXT,
      });
    const first = save();
    const second = save();
    await ready;
    releaseEmbeddings();

    const results = await Promise.all([first, second]);
    expect(results.map(({ acceptedCount }) => acceptedCount).sort()).toEqual([
      0, 1,
    ]);
    expect(results.map(({ duplicateCount }) => duplicateCount).sort()).toEqual([
      0, 1,
    ]);
    expect((await repository.read()).records).toHaveLength(1);
  });

  test("does not persist candidates after cancellation while awaiting the repository update", async () => {
    const base = createInMemoryLongTermMemoryRepository();
    const abortController = new AbortController();
    const repository = Object.freeze({
      read: () => base.read(),
      update: async (mutate: Parameters<typeof base.update>[0]) => {
        abortController.abort();
        return base.update(mutate);
      },
    });
    const service = createLongTermMemoryService({
      repository,
      embeddings: createSemanticFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-cancelled-passive-save",
    });

    await expect(
      service.processCandidates({
        candidates: [{ content: "Remember this preference.", tags: [] }],
        context: { ...REQUEST_CONTEXT, abortSignal: abortController.signal },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(base.read()).resolves.toMatchObject({
      records: [],
      vectors: [],
    });
  });

  test.each([" ", "x".repeat(129)])(
    "rejects an invalid generated passive-memory id without persisting: %j",
    async (generatedId) => {
      const repository = createInMemoryLongTermMemoryRepository();
      const service = createLongTermMemoryService({
        repository,
        embeddings: createSemanticFixtureEmbeddings(),
        enabled: true,
        emitClientEvents: false,
        createId: () => generatedId,
      });

      await expect(
        service.processCandidates({
          candidates: [{ content: "Remember this preference.", tags: [] }],
          context: REQUEST_CONTEXT,
        }),
      ).resolves.toMatchObject({ available: false, acceptedCount: 0 });
      await expect(repository.read()).resolves.toMatchObject({
        records: [],
        vectors: [],
      });
    },
  );

  test("rejects a generated passive-memory id that is already in use", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const service = createLongTermMemoryService({
      repository,
      embeddings: createSemanticFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-shared-id",
    });
    await service.processCandidates({
      candidates: [{ content: "First durable preference.", tags: [] }],
      context: REQUEST_CONTEXT,
    });

    await expect(
      service.processCandidates({
        candidates: [{ content: "Second durable preference.", tags: [] }],
        context: REQUEST_CONTEXT,
      }),
    ).resolves.toMatchObject({ available: false, acceptedCount: 0 });
    await expect(repository.read()).resolves.toMatchObject({
      records: [expect.objectContaining({ content: "First durable preference." })],
      vectors: [expect.objectContaining({ memoryId: "memory-shared-id" })],
    });
  });

  test("exposes canonical management without vectors", async () => {
    const service = createLongTermMemoryService({
      repository: createInMemoryLongTermMemoryRepository(),
      embeddings: createSemanticFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-managed",
    });
    await service.processCandidates({
      candidates: [{ content: "User prefers coffee.", tags: ["coffee"] }],
      context: REQUEST_CONTEXT,
    });

    const listed = await service.list();
    expect(JSON.stringify(listed)).not.toContain("vector");
    await expect(service.delete({ id: "memory-managed" })).resolves.toEqual({
      deleted: true,
    });
    await expect(service.clear()).resolves.toEqual({ deletedCount: 0 });
    await expect(service.status()).resolves.toMatchObject({
      recordCount: 0,
      indexedRecordCount: 0,
    });
  });
});

function createSemanticFixtureEmbeddings(
  modelFingerprint = "fixture-multilingual-v1",
): LongTermMemoryEmbeddingClient {
  return {
    async embed(input) {
      return Object.freeze({
        modelFingerprint,
        dimensions: 2,
        vectors: Object.freeze(input.texts.map(projectFixtureVector)),
      });
    },
  };
}

function projectFixtureVector(text: string): readonly number[] {
  const coffee = /coffee|קפה|dark mode/iu.test(text);
  return coffee ? Object.freeze([1, 0]) : Object.freeze([0, 1]);
}

function createFixtureRecord(index: number): LongTermMemoryRecord {
  return Object.freeze({
    id: `memory-${index}`,
    content: `Fixture memory ${index}`,
    tags: Object.freeze(["fixture"]),
    provenance: Object.freeze({
      kind: "manual" as const,
      source: "management_api" as const,
    }),
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  });
}
