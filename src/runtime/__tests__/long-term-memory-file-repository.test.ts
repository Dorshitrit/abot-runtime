import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createFileLongTermMemoryRepository } from "../adapters/long-term-memory/file-repository.js";
import type { LongTermMemoryRecord } from "../long-term-memory/contracts.js";

describe("file long-term memory repository", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("serializes concurrent updates without losing canonical records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "abot-memory-store-"));
    directories.push(directory);
    const repository = createFileLongTermMemoryRepository(directory);

    await Promise.all([
      repository.update((current) => ({
        records: [...current.records, createRecord("one")],
        vectors: current.vectors,
      })),
      repository.update((current) => ({
        records: [...current.records, createRecord("two")],
        vectors: current.vectors,
      })),
    ]);

    const snapshot = await repository.read();
    expect(snapshot.records.map(({ id }) => id).sort()).toEqual(["one", "two"]);
    expect(snapshot.revision).toBe(2);
    expect(await readdir(directory)).toEqual(["memory.json"]);
  });

  test("writes snapshots with private permissions and tightens replacements", async () => {
    const directory = await mkdtemp(join(tmpdir(), "abot-memory-private-"));
    directories.push(directory);
    const storePath = join(directory, "memory.json");
    const repository = createFileLongTermMemoryRepository(directory);

    await repository.update((current) => ({
      records: [...current.records, createRecord("private")],
      vectors: current.vectors,
    }));
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);

    await chmod(storePath, 0o644);
    await repository.update((current) => ({
      records: current.records,
      vectors: current.vectors,
    }));
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
  });

  test("rejects a corrupt store instead of silently replacing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "abot-memory-corrupt-"));
    directories.push(directory);
    await writeFile(join(directory, "memory.json"), "{broken", "utf8");
    const repository = createFileLongTermMemoryRepository(directory);

    await expect(repository.read()).rejects.toThrow();
    expect(await readFile(join(directory, "memory.json"), "utf8")).toBe(
      "{broken",
    );
  });

  test("rejects the unsupported QA schema without rewriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "abot-memory-schema-"));
    directories.push(directory);
    const storePath = join(directory, "memory.json");
    const unsupported = JSON.stringify({
      schemaVersion: 2,
      revision: 0,
      records: [],
      vectors: [],
    });
    await writeFile(storePath, unsupported, "utf8");
    const repository = createFileLongTermMemoryRepository(directory);

    await expect(repository.read()).rejects.toThrow(
      "long_term_memory_store_schema_unsupported",
    );
    expect(await readFile(storePath, "utf8")).toBe(unsupported);
  });
});

function createRecord(id: string): LongTermMemoryRecord {
  return Object.freeze({
    id,
    content: `Memory ${id}`,
    tags: Object.freeze([]),
    provenance: Object.freeze({
      kind: "passive_response" as const,
      sourceSessionId: "session",
      sourceRequestId: "request",
    }),
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  });
}
