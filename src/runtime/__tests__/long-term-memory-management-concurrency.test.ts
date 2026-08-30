import { describe, expect, test } from "vitest";

import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryRepository,
} from "../long-term-memory/contracts.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";

describe("long-term memory management concurrency", () => {
  test("does not create a record after cancellation while awaiting the repository", async () => {
    const controlled = createControlledRepository();
    const service = createLongTermMemoryService({
      repository: controlled.repository,
      embeddings: createFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-cancelled-create",
    });
    const updateGate = controlled.blockNextUpdate();
    const abortController = new AbortController();
    const pending = service.create({
      content: "User prefers concise answers.",
      tags: ["preference"],
      source: "web_ui",
      context: { abortSignal: abortController.signal },
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });

    await updateGate.waitUntilBlocked();
    abortController.abort();
    updateGate.release();

    await rejected;
    await expect(controlled.repository.read()).resolves.toMatchObject({
      records: [],
      vectors: [],
    });
  });

  test("does not update tags after cancellation while awaiting the repository", async () => {
    const controlled = createControlledRepository();
    const service = createLongTermMemoryService({
      repository: controlled.repository,
      embeddings: createFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-cancelled-update",
    });
    const created = await service.create({
      content: "User prefers concise answers.",
      tags: ["preference"],
      source: "web_ui",
      context: { abortSignal: new AbortController().signal },
    });
    const before = await controlled.repository.read();
    const updateGate = controlled.blockNextUpdate();
    const abortController = new AbortController();
    const pending = service.update({
      id: created.record.id,
      expectedUpdatedAt: created.record.updatedAt,
      content: created.record.content,
      tags: ["preference", "concise"],
      context: { abortSignal: abortController.signal },
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });

    await updateGate.waitUntilBlocked();
    abortController.abort();
    updateGate.release();

    await rejected;
    await expect(controlled.repository.read()).resolves.toEqual(before);
  });

  test("reports only the delete that removed the locked record", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const creator = createLongTermMemoryService({
      repository,
      embeddings: createFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-concurrent-delete",
    });
    await creator.create({
      content: "User prefers concise answers.",
      tags: ["preference"],
      source: "web_ui",
      context: { abortSignal: new AbortController().signal },
    });
    const deletionService = createLongTermMemoryService({
      repository: createTwoReaderBarrierRepository(repository),
      enabled: false,
      emitClientEvents: false,
    });

    const outcomes = await Promise.all([
      deletionService.delete({ id: "memory-concurrent-delete" }),
      deletionService.delete({ id: "memory-concurrent-delete" }),
    ]);

    expect(outcomes.filter(({ deleted }) => deleted)).toHaveLength(1);
    expect(outcomes.filter(({ deleted }) => !deleted)).toHaveLength(1);
    await expect(repository.read()).resolves.toMatchObject({
      records: [],
      vectors: [],
    });
  });

  test("counts every record removed from the locked clear snapshot", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const firstCreator = createLongTermMemoryService({
      repository,
      embeddings: createFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-clear-first",
    });
    await firstCreator.create({
      content: "User prefers concise answers.",
      tags: ["preference"],
      source: "web_ui",
      context: { abortSignal: new AbortController().signal },
    });
    const concurrentCreator = createLongTermMemoryService({
      repository,
      embeddings: createFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-clear-concurrent",
    });
    let injected = false;
    const clearRepository: LongTermMemoryRepository = Object.freeze({
      read: () => repository.read(),
      async update(mutate) {
        if (!injected) {
          injected = true;
          await concurrentCreator.create({
            content: "User prefers dark mode.",
            tags: ["preference"],
            source: "web_ui",
            context: { abortSignal: new AbortController().signal },
          });
        }
        return repository.update(mutate);
      },
    });
    const clearingService = createLongTermMemoryService({
      repository: clearRepository,
      enabled: false,
      emitClientEvents: false,
    });

    await expect(clearingService.clear()).resolves.toEqual({ deletedCount: 2 });
    await expect(repository.read()).resolves.toMatchObject({
      records: [],
      vectors: [],
    });
  });
});

function createFixtureEmbeddings(): LongTermMemoryEmbeddingClient {
  return Object.freeze({
    async embed(input) {
      return Object.freeze({
        modelFingerprint: "fixture-management-concurrency-v1",
        dimensions: 2,
        vectors: Object.freeze(
          input.texts.map(() => Object.freeze([1, 0] as const)),
        ),
      });
    },
  });
}

function createControlledRepository(): Readonly<{
  repository: LongTermMemoryRepository;
  blockNextUpdate(): Readonly<{
    waitUntilBlocked(): Promise<void>;
    release(): void;
  }>;
}> {
  const base = createInMemoryLongTermMemoryRepository();
  let pendingGate: UpdateGate | undefined;
  const repository: LongTermMemoryRepository = Object.freeze({
    read: () => base.read(),
    async update(mutate) {
      const gate = pendingGate;
      pendingGate = undefined;
      if (gate) {
        gate.blocked.resolve();
        await gate.release.promise;
      }
      return base.update(mutate);
    },
  });
  return Object.freeze({
    repository,
    blockNextUpdate() {
      if (pendingGate) {
        throw new Error("long_term_memory_test_update_already_blocked");
      }
      const gate = createUpdateGate();
      pendingGate = gate;
      return Object.freeze({
        waitUntilBlocked: () => gate.blocked.promise,
        release: gate.release.resolve,
      });
    },
  });
}

function createTwoReaderBarrierRepository(
  base: LongTermMemoryRepository,
): LongTermMemoryRepository {
  const readersReady = createSignal();
  let readerCount = 0;
  return Object.freeze({
    async read() {
      const snapshot = await base.read();
      readerCount += 1;
      if (readerCount === 2) {
        readersReady.resolve();
      }
      await readersReady.promise;
      return snapshot;
    },
    update: (mutate) => base.update(mutate),
  });
}

type UpdateGate = Readonly<{
  blocked: ReturnType<typeof createSignal>;
  release: ReturnType<typeof createSignal>;
}>;

function createUpdateGate(): UpdateGate {
  return Object.freeze({ blocked: createSignal(), release: createSignal() });
}

function createSignal(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((completed) => {
    resolve = completed;
  });
  return Object.freeze({ promise, resolve });
}
