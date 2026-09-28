import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileLongTermMemoryRepository } from "../adapters/long-term-memory/file-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { LearningJournal } from "../passive-learning/journal.js";
import { processLearningBatch } from "../passive-learning/process-batch.js";
import {
  createLearningStateStore,
  DEFAULT_LEARNING_PREFERENCES,
} from "../passive-learning/store.js";
import type { LearningBatch } from "../passive-learning/contracts.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "learning-journal-"));
  directories.push(directory);
  const openMemory = () =>
    createLongTermMemoryService({
      repository: createFileLongTermMemoryRepository(join(directory, "memory")),
      enabled: true,
      emitClientEvents: false,
      embeddings: {
        async embed({ texts }) {
          return {
            modelFingerprint: "test",
            dimensions: 2,
            vectors: texts.map(() => [1, 0]),
          };
        },
      },
    });
  const timestamp = new Date().toISOString();
  const batch: LearningBatch = {
    id: "batch",
    generation: "generation",
    createdAt: timestamp,
    status: "processing",
    reason: "learning_stopped",
    recordIds: [],
    observations: [
      {
        id: "observation",
        deviceId: "device",
        timestamp,
        sequence: 1,
        source: { app: "editor", windowId: "one" },
        content: "Project notes",
        kind: "view",
        extraction: "uia",
        coverage: "complete",
      },
    ],
  };
  return { directory, openMemory, batch };
}

describe("learning journal and canonical commit boundary", () => {
  it("reconciles a crash after candidate commit without resurrecting a deleted candidate", async () => {
    const { directory, openMemory, batch } = await fixture();
    const journalDirectory = join(directory, "journal");
    await createLearningStateStore(journalDirectory).write({
      schemaVersion: 1,
      preferences: { ...DEFAULT_LEARNING_PREFERENCES, processingPaused: false },
      batches: [batch],
    });
    const input = {
      batchId: batch.id,
      batchExpiresAt: new Date(
        Date.parse(batch.createdAt) + 86_400_000,
      ).toISOString(),
      environmentId: "env",
      observations: batch.observations,
      abortSignal: new AbortController().signal,
      proposals: [
        {
          content: "Works with project notes",
          tags: [],
          observationIds: ["observation"],
          reason: "Observed workflow",
          certainty: "observed" as const,
        },
      ],
    };
    const receipt = await openMemory().saveObservationBatch!(input);
    const restartedMemory = openMemory();
    expect(receipt.recordIds).toEqual([]);
    expect(receipt.candidateIds).toHaveLength(1);
    await createFileLongTermMemoryRepository(join(directory, "memory"))
      .update((current) => ({ ...current, learningCandidates: [] }));
    const journal = new LearningJournal({
      directory: journalDirectory,
      now: Date.now,
      preferences: () => ({ ...DEFAULT_LEARNING_PREFERENCES, processingPaused: false }),
      changed() {},
      failed(error) {
        throw error;
      },
      receipt: (id) => restartedMemory.observationBatchReceipt!(id),
    });
    await journal.load();
    expect(journal.items[0]).toMatchObject({
      status: "reviewed",
      recordIds: receipt.recordIds,
      candidateIds: receipt.candidateIds,
    });
    expect(journal.items[0]?.reason).toBeUndefined();
    expect(await restartedMemory.saveObservationBatch!(input)).toEqual(receipt);
    expect((await restartedMemory.list()).items).toEqual([]);
    expect(await restartedMemory.learning!.list()).toEqual([]);
    expect(
      (await createLearningStateStore(journalDirectory).read()).batches[0]
        ?.status,
    ).toBe("reviewed");
  });
  it("reports a journal failure separately once canonical memory committed", async () => {
    const { openMemory, batch } = await fixture();
    const memory = openMemory();
    const failed = vi.fn();
    const statuses: string[] = [];
    await processLearningBatch({
      batch,
      signal: new AbortController().signal,
      modelProfileId: "model",
      model: {
        validateProfile() {},
        async extract() {
          return [];
        },
      },
      memory,
      ownerId: "env",
      isCurrent: () => true,
      timestamp: () => new Date().toISOString(),
      failed,
      async replace(value) {
        statuses.push(value.status);
        if (value.status === "discarded")
          throw new Error("learning_storage_unavailable");
      },
    });
    expect(statuses).toEqual(["processing", "discarded"]);
    expect(failed).toHaveBeenCalledOnce();
    expect(await memory.observationBatchReceipt!(batch.id)).toMatchObject({
      batchId: batch.id,
      recordIds: [],
    });
  });
});
