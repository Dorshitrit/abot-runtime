import { describe, expect, test, vi } from "vitest";

import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import type {
  LongTermMemoryEmbeddingClient,
  LongTermMemoryManagementContext,
} from "../long-term-memory/contracts.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";

const MANAGEMENT_CONTEXT: LongTermMemoryManagementContext = {
  abortSignal: new AbortController().signal,
  debugRequestId: "memory-management-test",
};

describe("long-term memory management", () => {
  test("keeps inspection and deletion available while disabled", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const service = createLongTermMemoryService({
      repository,
      enabled: false,
      emitClientEvents: false,
    });

    await expect(service.list()).resolves.toEqual({ items: [], total: 0 });
    await expect(service.delete({ id: "missing" })).resolves.toEqual({
      deleted: false,
    });
    await expect(
      service.create({
        content: "User prefers concise answers.",
        tags: ["preference"],
        source: "web_ui",
        context: MANAGEMENT_CONTEXT,
      }),
    ).rejects.toMatchObject({ code: "long_term_memory_disabled" });
    await expect(
      service.search({ query: "answers", context: MANAGEMENT_CONTEXT }),
    ).rejects.toMatchObject({ code: "long_term_memory_disabled" });
  });

  test("creates and searches the canonical manual record", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const service = createLongTermMemoryService({
      repository,
      embeddings: createFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      now: () => new Date("2026-08-26T10:00:00.000Z"),
      createId: () => "memory-manual",
    });

    const created = await service.create({
      content: " User prefers coffee without sugar. ",
      tags: ["Coffee", "Preference"],
      source: "web_ui",
      context: MANAGEMENT_CONTEXT,
    });
    const searched = await service.search({
      query: "איך המשתמש אוהב קפה?",
      context: MANAGEMENT_CONTEXT,
    });

    expect(created.record).toEqual({
      id: "memory-manual",
      content: "User prefers coffee without sugar.",
      tags: ["coffee", "preference"],
      provenance: { kind: "manual", source: "web_ui" },
      createdAt: "2026-08-26T10:00:00.000Z",
      updatedAt: "2026-08-26T10:00:00.000Z",
    });
    expect(searched).toMatchObject({ total: 1 });
    expect(searched.items.map(({ id }) => id)).toEqual(["memory-manual"]);
    expect(JSON.stringify(searched)).not.toContain("vector");
  });

  test("rejects secrets and exact duplicates before a second write", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const embeddings = createFixtureEmbeddings();
    const service = createLongTermMemoryService({
      repository,
      embeddings,
      enabled: true,
      emitClientEvents: false,
      createId: vi
        .fn()
        .mockReturnValueOnce("memory-one")
        .mockReturnValueOnce("memory-two"),
    });
    await service.create({
      content: "User prefers dark mode.",
      tags: ["ux"],
      source: "management_api",
      context: MANAGEMENT_CONTEXT,
    });
    const callsAfterFirstCreate = vi.mocked(embeddings.embed).mock.calls.length;

    await expect(
      service.create({
        content: " User prefers dark mode. ",
        tags: ["preference"],
        source: "web_ui",
        context: MANAGEMENT_CONTEXT,
      }),
    ).rejects.toMatchObject({
      code: "long_term_memory_management_duplicate",
      memoryId: "memory-one",
    });
    expect(vi.mocked(embeddings.embed)).toHaveBeenCalledTimes(
      callsAfterFirstCreate,
    );
    await expect(
      service.create({
        content: "api_key=sk-abcdefghijklmnopqrstuvwxyz",
        tags: ["secret"],
        source: "web_ui",
        context: MANAGEMENT_CONTEXT,
      }),
    ).rejects.toMatchObject({
      code: "long_term_memory_management_sensitive_data",
    });
    await expect(
      service.create({
        content: "User prefers compact navigation.",
        tags: ["api_key=sk-abcdefghijklmnopqrstuvwxyz"],
        source: "web_ui",
        context: MANAGEMENT_CONTEXT,
      }),
    ).rejects.toMatchObject({
      code: "long_term_memory_management_sensitive_data",
    });
    expect(vi.mocked(embeddings.embed)).toHaveBeenCalledTimes(
      callsAfterFirstCreate,
    );
    expect((await repository.read()).records).toHaveLength(1);
  });

  test("updates by exact id and expected timestamp while preserving provenance", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const now = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date("2026-08-26T10:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-08-26T11:00:00.000Z"));
    const service = createLongTermMemoryService({
      repository,
      embeddings: createFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      now,
      createId: () => "memory-update",
    });
    const created = await service.create({
      content: "User prefers coffee.",
      tags: ["coffee"],
      source: "web_ui",
      context: MANAGEMENT_CONTEXT,
    });

    const updated = await service.update({
      id: created.record.id,
      expectedUpdatedAt: created.record.updatedAt,
      content: "User prefers tea.",
      tags: ["Tea", "Preference"],
      context: MANAGEMENT_CONTEXT,
    });
    const snapshot = await repository.read();

    expect(updated).toMatchObject({
      updated: true,
      record: {
        content: "User prefers tea.",
        tags: ["tea", "preference"],
        provenance: { kind: "manual", source: "web_ui" },
        createdAt: "2026-08-26T10:00:00.000Z",
        updatedAt: "2026-08-26T11:00:00.000Z",
      },
    });
    expect(snapshot.vectors).toHaveLength(1);
    expect(snapshot.vectors[0]).toMatchObject({
      memoryId: "memory-update",
      vector: [0, 1],
    });
    await expect(
      service.update({
        id: created.record.id,
        expectedUpdatedAt: created.record.updatedAt,
        content: "User prefers water.",
        tags: ["water"],
        context: MANAGEMENT_CONTEXT,
      }),
    ).rejects.toMatchObject({
      code: "long_term_memory_management_conflict",
      memoryId: "memory-update",
    });
  });

  test("updates tags without calling the embedding provider", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const embeddings = createFixtureEmbeddings();
    const service = createLongTermMemoryService({
      repository,
      embeddings,
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-tags",
    });
    const created = await service.create({
      content: "User prefers coffee.",
      tags: ["coffee"],
      source: "web_ui",
      context: MANAGEMENT_CONTEXT,
    });
    vi.mocked(embeddings.embed).mockClear();

    const updated = await service.update({
      id: created.record.id,
      expectedUpdatedAt: created.record.updatedAt,
      content: created.record.content,
      tags: ["coffee", "preference"],
      context: MANAGEMENT_CONTEXT,
    });

    expect(updated).toMatchObject({
      updated: true,
      record: { tags: ["coffee", "preference"] },
    });
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect((await repository.read()).vectors).toHaveLength(1);
  });

  test("rejects oversized manual content and tags without truncation", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const embeddings = createFixtureEmbeddings();
    const service = createLongTermMemoryService({
      repository,
      embeddings,
      enabled: true,
      emitClientEvents: false,
    });

    await expect(
      service.create({
        content: "x".repeat(4_001),
        tags: [],
        source: "web_ui",
        context: MANAGEMENT_CONTEXT,
      }),
    ).rejects.toMatchObject({
      code: "long_term_memory_management_input_invalid",
    });
    await expect(
      service.create({
        content: "Valid content",
        tags: ["x".repeat(65)],
        source: "web_ui",
        context: MANAGEMENT_CONTEXT,
      }),
    ).rejects.toMatchObject({
      code: "long_term_memory_management_input_invalid",
    });
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect((await repository.read()).records).toEqual([]);
  });

  test("leaves the record and vector unchanged when update embedding fails", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const initial = createLongTermMemoryService({
      repository,
      embeddings: createFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-stable",
    });
    const created = await initial.create({
      content: "User prefers coffee.",
      tags: ["coffee"],
      source: "web_ui",
      context: MANAGEMENT_CONTEXT,
    });
    const before = await repository.read();
    const failing = createLongTermMemoryService({
      repository,
      embeddings: {
        async embed() {
          throw new Error("provider_unavailable");
        },
      },
      enabled: true,
      emitClientEvents: false,
    });

    await expect(
      failing.update({
        id: created.record.id,
        expectedUpdatedAt: created.record.updatedAt,
        content: "User prefers tea.",
        tags: ["tea"],
        context: MANAGEMENT_CONTEXT,
      }),
    ).rejects.toMatchObject({ code: "long_term_memory_unavailable" });
    expect(await repository.read()).toEqual(before);
  });

  test("deletes the canonical record and every derived vector", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const service = createLongTermMemoryService({
      repository,
      embeddings: createFixtureEmbeddings(),
      enabled: true,
      emitClientEvents: false,
      createId: () => "memory-delete",
    });
    await service.create({
      content: "User prefers coffee.",
      tags: ["coffee"],
      source: "web_ui",
      context: MANAGEMENT_CONTEXT,
    });

    await expect(service.delete({ id: "memory-delete" })).resolves.toEqual({
      deleted: true,
    });
    const snapshot = await repository.read();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.vectors).toEqual([]);
  });
});

function createFixtureEmbeddings(): LongTermMemoryEmbeddingClient {
  return {
    embed: vi.fn(
      async (input: Parameters<LongTermMemoryEmbeddingClient["embed"]>[0]) =>
        Object.freeze({
          modelFingerprint: "fixture-management-v1",
          dimensions: 2,
          vectors: Object.freeze(
            input.texts.map((text) =>
              /coffee|קפה|dark mode/iu.test(text)
                ? Object.freeze([1, 0])
                : Object.freeze([0, 1]),
            ),
          ),
        }),
    ),
  };
}
