import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SchedulerJob,
  SchedulerSnapshot,
} from "../../scheduler/contracts.js";
import { createFileSchedulerStore } from "../../scheduler/file-store.js";
import { makeSchedulerRun } from "../../scheduler/run-records.js";

export interface CheckpointManifest {
  schemaVersion: number;
  generation: string;
  sequence: number;
  checkpoint?: { file: string; sequence: number };
}

export async function readCheckpointManifest(
  directory: string,
): Promise<CheckpointManifest> {
  return JSON.parse(
    await readFile(join(directory, "scheduler-journal.json"), "utf8"),
  );
}

export function committedCheckpointPath(
  directory: string,
  manifest: CheckpointManifest,
): string {
  if (!manifest.checkpoint) throw new Error("committed checkpoint is required");
  return join(
    directory,
    manifest.generation,
    "checkpoints",
    manifest.checkpoint.file,
  );
}

export function checkpointTransactionPath(
  directory: string,
  generation: string,
  sequence: number,
): string {
  return join(
    directory,
    generation,
    `${String(sequence).padStart(16, "0")}.json`,
  );
}

export async function createCheckpointFixture(
  cleanups: Array<() => Promise<void>>,
  prepareSnapshot?: (snapshot: SchedulerSnapshot) => void,
) {
  const directory = await mkdtemp(
    join(tmpdir(), "scheduler-checkpoint-fault-"),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const generation = `generation-${randomUUID()}`;
  await mkdir(join(directory, generation));
  const jobs: SchedulerJob[] = ["deleted", "retained"].map((id) => ({
    id,
    sessionId: id,
    environmentId: "test",
    title: id,
    prompt: `${id}-private-prompt`,
    modelProfileId: "model",
    agentMode: "fast",
    toolPermissionMode: "full_access",
    timeZone: "UTC",
    state: "active",
    schedule: { kind: "daily", at: "09:00" },
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    nextRunAt: "2026-09-07T09:00:00.000Z",
  }));
  const snapshot: SchedulerSnapshot = {
    schemaVersion: 1,
    jobs,
    runs: jobs.map((job) => ({
      ...makeSchedulerRun(job, "2026-09-06T09:00:00.000Z", "manual"),
      status: "succeeded" as const,
      resultText: `${job.id}-private-result`,
    })),
  };
  const empty = {
    version: 1,
    jobs: [],
    runs: [],
    deletedJobs: [],
    deletedRuns: [],
  };
  prepareSnapshot?.(snapshot);
  await writeFile(
    checkpointTransactionPath(directory, generation, 1),
    JSON.stringify({ ...empty, jobs }),
  );
  await writeFile(
    checkpointTransactionPath(directory, generation, 2),
    JSON.stringify({ ...empty, runs: snapshot.runs }),
  );
  await writeFile(
    join(directory, "scheduler-journal.json"),
    JSON.stringify({ schemaVersion: 2, generation }),
  );
  const own = async () => {
    const store = createFileSchedulerStore(directory);
    let release: (() => Promise<void>) | undefined = await store.acquire();
    const close = async () => {
      const current = release;
      release = undefined;
      await current?.();
    };
    cleanups.push(close);
    return { store, close };
  };
  return {
    directory,
    generation,
    snapshot,
    own,
    fresh: () => createFileSchedulerStore(directory),
  };
}
