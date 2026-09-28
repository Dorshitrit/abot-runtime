import { readFile, writeFile } from "node:fs/promises";
import type { LongTermMemoryRepositorySnapshot } from "../../long-term-memory/contracts.js";
import { parseMemorySnapshot } from "../../long-term-memory/repository-state.js";

/** Preserve one private rollback snapshot before each incompatible replacement. */
export async function preserveMemoryMigrationBackup(
  storePath: string,
  current: LongTermMemoryRepositorySnapshot,
  next: LongTermMemoryRepositorySnapshot,
): Promise<void> {
  const version = memoryUpgradeVersion(current, next);
  if (version === undefined) return;
  const original = await readExistingSnapshot(storePath);
  if (original === undefined) return;
  const backupPath = `${storePath}.pre-v${version}.backup`;
  try {
    await writeFile(backupPath, original, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!hasFileErrorCode(error, "EEXIST")) throw error;
    const existing = parseMemorySnapshot(JSON.parse(await readFile(backupPath, "utf8")));
    if (existing.schemaVersion >= version) throw new Error("long_term_memory_migration_backup_invalid");
  }
}

function memoryUpgradeVersion(current: LongTermMemoryRepositorySnapshot, next: LongTermMemoryRepositorySnapshot): 4 | 5 | undefined {
  if (current.schemaVersion < 5 && next.schemaVersion === 5) return 5;
  if (current.schemaVersion < 4 && next.schemaVersion === 4) return 4;
  return undefined;
}

async function readExistingSnapshot(storePath: string): Promise<string | undefined> {
  try { return await readFile(storePath, "utf8"); }
  catch (error) {
    if (hasFileErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function hasFileErrorCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && error.code === code;
}
