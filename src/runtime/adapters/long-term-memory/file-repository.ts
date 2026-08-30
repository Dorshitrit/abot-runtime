import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  LongTermMemoryRepository,
  LongTermMemoryRepositorySnapshot,
} from "../../long-term-memory/contracts.js";
import {
  advanceMemorySnapshot,
  createEmptyMemorySnapshot,
  parseMemorySnapshot,
} from "../../long-term-memory/repository-state.js";
import { withFileLock } from "./file-lock.js";

const STORE_FILE_NAME = "memory.json";
const LOCK_FILE_NAME = "memory.lock";
const PRIVATE_STORE_FILE_MODE = 0o600;

export function createFileLongTermMemoryRepository(
  directory: string,
): LongTermMemoryRepository {
  const storePath = join(directory, STORE_FILE_NAME);
  const lockPath = join(directory, LOCK_FILE_NAME);
  return Object.freeze({
    read: () => readSnapshot(storePath),
    update: async (mutate) => {
      await mkdir(directory, { recursive: true });
      return withFileLock(lockPath, async () => {
        const current = await readSnapshot(storePath);
        const next = advanceMemorySnapshot(current, mutate(current));
        await writeSnapshot(storePath, next);
        return next;
      });
    },
  });
}

async function readSnapshot(
  storePath: string,
): Promise<LongTermMemoryRepositorySnapshot> {
  try {
    return parseMemorySnapshot(JSON.parse(await readFile(storePath, "utf8")));
  } catch (error) {
    if (isMissingFile(error)) {
      return createEmptyMemorySnapshot();
    }
    throw error;
  }
}

async function writeSnapshot(
  storePath: string,
  snapshot: LongTermMemoryRepositorySnapshot,
): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_STORE_FILE_MODE,
    });
    await rename(temporaryPath, storePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
