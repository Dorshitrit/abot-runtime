import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileLongTermMemoryRepository } from "../adapters/long-term-memory/file-repository.js";
import type { LongTermMemoryRepositorySnapshot } from "../long-term-memory/contracts.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("memory schema upgrade backup", () => {
  it.each([1, 3, 4] as const)("preserves the exact v%s snapshot before storing the shared v5 policy", async (schemaVersion) => {
    const directory = await createDirectory();
    const path = join(directory, "memory.json");
    const original = JSON.stringify({ ...legacySnapshot(1), schemaVersion });
    await writeFile(path, original);
    const repository = createFileLongTermMemoryRepository(directory);
    await repository.update((current) => ({ ...current,
      maturationPolicy: { promotionScore: 95, retentionDays: 30, maxCandidates: 500, maxBytes: 2097152 } }));
    expect(await readFile(path + ".pre-v5.backup", "utf8")).toBe(original);
    expect((await stat(path + ".pre-v5.backup")).mode & 0o777).toBe(0o600);
    expect((await repository.read()).schemaVersion).toBe(5);
    await repository.update((current) => ({ ...current, records: [] }));
    expect(await readFile(path + ".pre-v5.backup", "utf8")).toBe(original);
  });

  it.each([1, 3] as const)("preserves the exact v%s snapshot privately before v4, without rewriting it later", async (schemaVersion) => {
    const directory = await createDirectory();
    const path = join(directory, "memory.json");
    const original = JSON.stringify(legacySnapshot(schemaVersion), null, 4) + "\n";
    await writeFile(path, original);
    const repository = createFileLongTermMemoryRepository(directory);
    await repository.read();
    expect(await readdir(directory)).toEqual(["memory.json"]);
    await repository.update((current) => ({ ...current, records: current.records.map((record) => ({ ...record, automaticManagement: "protected" })) }));
    const backup = `${path}.pre-v4.backup`;
    expect(await readFile(backup, "utf8")).toBe(original);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect((await repository.read()).schemaVersion).toBe(4);
    await repository.update((current) => ({ ...current, records: [] }));
    expect(await readFile(backup, "utf8")).toBe(original);
    expect((await readdir(directory)).sort()).toEqual(["memory.json", "memory.json.pre-v4.backup"]);
  });

  it("keeps a valid earlier rollback backup when a legacy snapshot is restored", async () => {
    const directory = await createDirectory();
    const path = join(directory, "memory.json");
    const first = JSON.stringify(legacySnapshot(1));
    const restored = JSON.stringify({ ...legacySnapshot(1), revision: 9 });
    await writeFile(`${path}.pre-v4.backup`, first);
    await writeFile(path, restored);
    const repository = createFileLongTermMemoryRepository(directory);
    await repository.update((current) => ({ ...current, learningCandidates: [] }));
    expect(await readFile(`${path}.pre-v4.backup`, "utf8")).toBe(first);
    expect((await repository.read()).revision).toBe(10);
  });

  it("fails before replacing the legacy store when an existing rollback backup is corrupt", async () => {
    const directory = await createDirectory();
    const path = join(directory, "memory.json");
    const original = JSON.stringify(legacySnapshot(3));
    await writeFile(path, original);
    await writeFile(`${path}.pre-v4.backup`, "invalid backup");
    const repository = createFileLongTermMemoryRepository(directory);
    await expect(repository.update((current) => ({ ...current, learningCandidates: [] }))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readFile(`${path}.pre-v4.backup`, "utf8")).toBe("invalid backup");
  });

  it("does not create an unnecessary rollback copy for a new installation", async () => {
    const directory = await createDirectory();
    const repository = createFileLongTermMemoryRepository(directory);
    await repository.update((current) => ({ ...current, learningCandidates: [] }));
    expect((await repository.read()).schemaVersion).toBe(4);
    expect(await readdir(directory)).toEqual(["memory.json"]);
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "abot-memory-v4-"));
  directories.push(directory);
  return directory;
}

function legacySnapshot(schemaVersion: 1 | 3): LongTermMemoryRepositorySnapshot {
  return { schemaVersion, revision: 1, vectors: [], records: [{
    id: "old-memory", content: "A preference from an earlier version.", tags: [],
    provenance: { kind: "passive_response", sourceSessionId: "old-session", sourceRequestId: "old-request" },
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  }] };
}
