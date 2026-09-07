import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SchedulerRunListQuery, SchedulerSnapshot } from "./contracts.js";
import {
  SchedulerJournalIndex,
  isActiveSchedulerRun,
} from "./journal-index.js";
import {
  cleanObsoleteJournalGenerations,
  createJournalGeneration,
  initialJournalTransaction,
  isMissingJournalFile,
  journalTransactionName,
  loadJournalIndex,
  SCHEDULER_MANIFEST,
  writeJournalJson,
} from "./journal-files.js";
import {
  hasSchedulerTransactionChanges,
  schedulerTransaction,
  type SchedulerTransaction,
} from "./journal-transaction.js";
import { querySchedulerRuns } from "./run-list-query.js";
import { parseSchedulerSnapshot } from "./snapshot-validation.js";
import {
  MAX_JOURNAL_SUFFIX,
  readJournalHead,
  type CommittedJournalHead,
} from "./journal-head.js";
import {
  cleanObsoleteJournalCheckpoints,
  loadCheckpointJournalIndex,
  writeJournalCheckpoint,
} from "./journal-checkpoint.js";
import {
  JournalPublicationSyncError,
  syncJournalDirectory,
  syncJournalDirectoryPath,
} from "./journal-durability.js";

export class SchedulerJournalStore {
  private index = new SchedulerJournalIndex();
  private sequence = 0;
  private generation?: string;
  private head?: CommittedJournalHead;
  private legacy?: SchedulerSnapshot;
  private publicationFailure?: JournalPublicationSyncError;
  private ownedDirectoriesSynced = false;
  constructor(private readonly directory: string) {}

  async load(): Promise<this> {
    const head = await readJournalHead(this.directory);
    this.generation = head?.generation;
    if (head?.schemaVersion === 3) {
      const loaded = await loadCheckpointJournalIndex(this.directory, head);
      this.index = loaded.index;
      this.sequence = loaded.sequence;
      this.head = head;
      return this;
    }
    if (this.generation) {
      const loaded = await loadJournalIndex(this.directory, this.generation);
      this.index = loaded.index;
      this.sequence = loaded.sequence;
      return this;
    }
    try {
      this.legacy = parseSchedulerSnapshot(
        JSON.parse(
          await readFile(join(this.directory, "scheduler.json"), "utf8"),
        ),
      );
    } catch (error) {
      if (!isMissingJournalFile(error)) throw error;
      this.legacy = { schemaVersion: 1, jobs: [], runs: [] };
    }
    return this;
  }
  async prepareOwned(): Promise<void> {
    this.requireDurablePublication();
    await this.ensureOwnedDirectoriesSynced();
    await cleanObsoleteJournalGenerations(this.directory, this.generation);
    if (this.legacy) await this.replaceGeneration(this.legacy);
    if (requiresJournalCheckpoint(this.head, this.sequence)) {
      const head = await writeJournalCheckpoint(
        this.directory,
        this.generation!,
        this.sequence,
        this.index,
      );
      await this.publishHead(head);
      this.head = head;
    }
    await cleanObsoleteJournalCheckpoints(this.directory, this.head!);
  }
  async snapshot(view?: "active"): Promise<SchedulerSnapshot> {
    this.requireDurablePublication();
    if (!this.legacy) return this.index.snapshot(view);
    const runs =
      view === "active"
        ? this.legacy.runs.filter(isActiveSchedulerRun)
        : this.legacy.runs;
    return structuredClone({ ...this.legacy, runs });
  }
  async readRuns(jobId?: string, query?: SchedulerRunListQuery) {
    this.requireDurablePublication();
    if (!this.legacy) return this.index.readRuns(jobId, query);
    return structuredClone(querySchedulerRuns(this.legacy.runs, jobId, query));
  }
  async update<T>(
    mutate: (state: SchedulerSnapshot) => T,
    view?: "active",
  ): Promise<T> {
    // Retry storage cleanup before, never after committing an ordinary mutation.
    await this.prepareOwned();
    const before = await this.snapshot(view);
    const candidate = structuredClone(before);
    const result = structuredClone(mutate(candidate));
    const after = parseSchedulerSnapshot(structuredClone(candidate));
    const delta = schedulerTransaction(before, after, view);
    if (!hasSchedulerTransactionChanges(delta)) return result;
    this.index.validate(delta);
    if (hasJournalRemovals(delta)) {
      const complete =
        view === "active"
          ? applyWorkingChanges(await this.snapshot(), delta)
          : after;
      await this.replaceGeneration(complete);
      return result;
    }
    const file = join(
      this.directory,
      this.generation!,
      journalTransactionName(this.sequence + 1),
    );
    await writeJournalJson(file, delta);
    const head = { ...this.head!, sequence: this.sequence + 1 };
    await this.publishHead(head);
    this.index.apply(delta, file);
    this.sequence += 1;
    this.head = head;
    return result;
  }
  private async replaceGeneration(snapshot: SchedulerSnapshot): Promise<void> {
    const generation = await createJournalGeneration(this.directory);
    const index = new SchedulerJournalIndex();
    let sequence = 0;
    const append = async (delta: SchedulerTransaction) => {
      const file = join(
        this.directory,
        generation,
        journalTransactionName(++sequence),
      );
      index.validate(delta);
      await writeJournalJson(file, delta);
      index.apply(delta, file);
    };
    await append({ ...initialJournalTransaction(), jobs: snapshot.jobs });
    // Bound boot/import transaction payloads; ordinary commits contain only changes.
    for (let offset = 0; offset < snapshot.runs.length; offset += 32) {
      await append({
        ...initialJournalTransaction(),
        runs: snapshot.runs.slice(offset, offset + 32),
      });
    }
    const head = await writeJournalCheckpoint(
      this.directory,
      generation,
      sequence,
      index,
    );
    await this.publishHead(head);
    this.index = index;
    this.sequence = sequence;
    this.generation = generation;
    this.head = head;
    this.legacy = undefined;
    // Failed physical removal remains discoverable on the next explicit operation.
    await cleanObsoleteJournalGenerations(this.directory, generation);
  }
  private async ensureOwnedDirectoriesSynced(): Promise<void> {
    if (this.ownedDirectoriesSynced) return;
    // Older writers synced files only; establish their selected entries before cleanup.
    if (this.head)
      await syncJournalDirectory(
        join(this.directory, this.head.generation, "checkpoints"),
      );
    if (this.generation)
      await syncJournalDirectory(join(this.directory, this.generation));
    await syncJournalDirectoryPath(this.directory);
    this.ownedDirectoriesSynced = true;
  }
  private async publishHead(head: CommittedJournalHead): Promise<void> {
    try {
      await writeJournalJson(join(this.directory, SCHEDULER_MANIFEST), head);
    } catch (error) {
      if (error instanceof JournalPublicationSyncError)
        this.publicationFailure = error;
      throw error;
    }
  }
  private requireDurablePublication(): void {
    // A visible head may differ from this cache; only a new owned load may accept it.
    if (this.publicationFailure) throw this.publicationFailure;
  }
}
function requiresJournalCheckpoint(
  head: CommittedJournalHead | undefined,
  sequence: number,
): boolean {
  if (!head) return true;
  return sequence - head.checkpoint.sequence >= MAX_JOURNAL_SUFFIX;
}
function hasJournalRemovals(delta: SchedulerTransaction): boolean {
  return delta.deletedJobs.length > 0 || delta.deletedRuns.length > 0;
}
function applyWorkingChanges(
  snapshot: SchedulerSnapshot,
  delta: SchedulerTransaction,
): SchedulerSnapshot {
  const jobs = new Map(snapshot.jobs.map((job) => [job.id, job]));
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  for (const id of delta.deletedJobs) jobs.delete(id);
  for (const job of delta.jobs) jobs.set(job.id, job);
  for (const id of delta.deletedRuns) runs.delete(id);
  for (const run of delta.runs) runs.set(run.id, run);
  const jobOrder = delta.jobOrder ?? [...jobs.keys()];
  return {
    schemaVersion: 1,
    jobs: jobOrder.map((id) => jobs.get(id)!),
    runs: [...runs.values()].filter((run) => jobs.has(run.jobId)),
  };
}
