import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_EXEC_OUTPUT_RETENTION_MS,
  type ExecOutputBody,
  type ExecOutputRange,
  type ExecOutputStream,
} from "./output-contracts.js";
import {
  outputFailure,
  outputOwnerDirectory,
  outputStorageRoot,
  outputStreamPath,
  prepareOutputOwnerDirectory,
  readOutputOwner,
  readOutputSnapshot,
  writeOutputMetadata,
} from "./output-files.js";
import {
  assertOutputBodyHash,
  assertOutputRange,
  readOutputFileRange,
} from "./output-range-reader.js";
import { scheduleExecOutputCleanup } from "./output-maintenance.js";
import { hasOutputExpired } from "./output-retention.js";
import { createOutputWriter } from "./output-writer.js";

const activeWriters = new Map<string, number>();
const activeReaders = new Map<string, number>();
const ownerOperations = new Map<string, Promise<void>>();
async function withOutputOwnerLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = ownerOperations.get(directory) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  ownerOperations.set(directory, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ownerOperations.get(directory) === current)
      ownerOperations.delete(directory);
  }
}

export function createExecOutputStore(
  params: Readonly<{
    stateDir: string;
    retentionMs?: number;
    now?: () => number;
  }>,
) {
  const root = outputStorageRoot(params.stateDir);
  const retentionMs = params.retentionMs ?? DEFAULT_EXEC_OUTPUT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0)
    throw outputFailure("retention_invalid");
  const now = params.now ?? Date.now;
  async function retain(directory: string, ownerId: string) {
    await prepareOutputOwnerDirectory(directory);
    const previous = await readOutputOwner(directory);
    if (previous && previous.ownerId !== ownerId)
      throw outputFailure("owner_binding_invalid");
    if (previous?.completedAt === null) return;
    await writeOutputMetadata(join(directory, "owner.json"), {
      kind: "exec_output_owner_v1",
      ownerId,
      completedAt: null,
    });
  }
  const store = Object.freeze({
    async createWriter(
      input: Readonly<{ ownerId: string; stream: ExecOutputStream }>,
    ) {
      if (input.stream !== "stdout" && input.stream !== "stderr")
        throw outputFailure("stream_invalid");
      const directory = outputOwnerDirectory(root, input.ownerId);
      return withOutputOwnerLock(directory, async () => {
        await retain(directory, input.ownerId);
        const writer = await createOutputWriter({
          directory,
          ownerId: input.ownerId,
          stream: input.stream,
          async onClosed() {
            await withOutputOwnerLock(directory, async () => {
              const count = (activeWriters.get(directory) ?? 1) - 1;
              if (count > 0) activeWriters.set(directory, count);
              if (count > 0) return;
              activeWriters.delete(directory);
              await writeOutputMetadata(join(directory, "owner.json"), {
                kind: "exec_output_owner_v1",
                ownerId: input.ownerId,
                completedAt: now(),
              });
            });
          },
        });
        activeWriters.set(directory, (activeWriters.get(directory) ?? 0) + 1);
        store.startMaintenance();
        return writer;
      });
    },
    async *readRange(
      input: Readonly<{ ownerId: string; body: ExecOutputBody }> &
        ExecOutputRange,
    ): AsyncIterable<Uint8Array> {
      const directory = outputOwnerDirectory(root, input.ownerId);
      assertOutputRange(
        input.offset,
        input.offset + input.length,
        input.body.byteLength,
      );
      await withOutputOwnerLock(directory, async () => {
        const owner = await readOutputOwner(directory);
        if (!owner) throw outputFailure("expired_or_unavailable");
        if (owner.ownerId !== input.ownerId)
          throw outputFailure("owner_binding_invalid");
        if (
          !activeWriters.has(directory) &&
          (await hasOutputExpired(directory, owner, now(), retentionMs))
        )
          throw outputFailure("expired");
        activeReaders.set(directory, (activeReaders.get(directory) ?? 0) + 1);
      });
      try {
        const snapshot = await readOutputSnapshot(
          directory,
          input.ownerId,
          input.body,
        );
        const path = outputStreamPath(directory, snapshot.streamId);
        await assertOutputBodyHash(path, input.body, input.signal);
        yield* readOutputFileRange(path, {
          offset: input.body.startByte + input.offset,
          length: input.length,
          maxChunkBytes: input.maxChunkBytes,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } finally {
        const count = (activeReaders.get(directory) ?? 1) - 1;
        if (count > 0) activeReaders.set(directory, count);
        if (count === 0) activeReaders.delete(directory);
      }
    },
    startMaintenance(): void {
      scheduleExecOutputCleanup(root, retentionMs, () =>
        store.cleanupExpired(),
      );
    },
    async cleanupExpired(): Promise<number> {
      const directories = await readdir(root, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw outputFailure("cleanup_failed", error);
        },
      );
      let removed = 0;
      for (const entry of directories) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name))
          continue;
        const directory = join(root, entry.name);
        await withOutputOwnerLock(directory, async () => {
          if (activeWriters.has(directory)) return;
          if (activeReaders.has(directory)) return;
          const owner = await readOutputOwner(directory);
          if (owner && outputOwnerDirectory(root, owner.ownerId) !== directory)
            throw outputFailure("owner_binding_invalid");
          if (!(await hasOutputExpired(directory, owner, now(), retentionMs)))
            return;
          await rm(directory, { recursive: true });
          removed += 1;
        });
      }
      return removed;
    },
  });
  return store;
}
