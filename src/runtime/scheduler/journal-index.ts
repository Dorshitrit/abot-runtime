import { readFile } from "node:fs/promises";
import type {
  SchedulerJob,
  SchedulerRun,
  SchedulerRunListQuery,
  SchedulerSnapshot,
} from "./contracts.js";
import {
  assertJournalTransactionIds,
  parseSchedulerTransaction,
  type SchedulerTransaction,
} from "./journal-transaction.js";
import { querySchedulerRuns } from "./run-list-query.js";
import {
  matchesIndexedJournalRun,
  type JournalIndexState,
  type JournalRunEntry,
} from "./journal-index-state.js";
export class SchedulerJournalIndex {
  private jobs = new Map<string, SchedulerJob>();
  private runs = new Map<string, JournalRunEntry>();
  private active = new Map<string, SchedulerRun>();

  constructor(state?: JournalIndexState) {
    if (!state) return;
    const detached = structuredClone(state);
    this.jobs = new Map(detached.jobs.map((job) => [job.id, job]));
    this.runs = new Map(detached.runs.map((run) => [run.id, run]));
    for (const entry of this.runs.values()) {
      if (entry.active) this.active.set(entry.id, entry.active);
    }
  }

  exportState(): JournalIndexState {
    return structuredClone({
      jobs: [...this.jobs.values()],
      runs: [...this.runs.values()],
    });
  }

  validate(transaction: SchedulerTransaction): void {
    assertJournalTransactionIds(transaction);
    const jobs = new Map(this.jobs);
    for (const job of transaction.jobs) jobs.set(job.id, job);
    for (const id of transaction.deletedJobs) jobs.delete(id);
    for (const run of transaction.runs)
      assertJournalRunOwner(run, jobs.get(run.jobId));
    this.validateChangedJobHistory(transaction);
    if (transaction.jobOrder) assertJournalOrder(jobs, transaction.jobOrder);
    if (transaction.runOrder)
      assertJournalOrder(
        this.prospectiveRunIds(transaction),
        transaction.runOrder,
      );
  }

  private validateChangedJobHistory(transaction: SchedulerTransaction): void {
    const changed = new Map(
      transaction.jobs
        .filter((job) =>
          requiresJournalHistoryValidation(this.jobs.get(job.id), job),
        )
        .map((job) => [job.id, job]),
    );
    if (changed.size === 0) return;
    const replaced = new Set([
      ...transaction.deletedRuns,
      ...transaction.runs.map((run) => run.id),
    ]);
    for (const entry of this.runs.values()) {
      if (replaced.has(entry.id)) continue;
      const job = changed.get(entry.jobId);
      if (!job) continue;
      assertJournalRunOwner(entry, job);
    }
  }

  private prospectiveRunIds(transaction: SchedulerTransaction): Set<string> {
    const deletedJobs = new Set(transaction.deletedJobs);
    const ids = new Set(
      [...this.runs.values()]
        .filter((run) => !deletedJobs.has(run.jobId))
        .map((run) => run.id),
    );
    for (const id of transaction.deletedRuns) ids.delete(id);
    for (const run of transaction.runs) ids.add(run.id);
    return ids;
  }

  apply(transaction: SchedulerTransaction, file: string): void {
    this.validate(transaction);
    for (const job of transaction.jobs) this.jobs.set(job.id, job);
    for (const id of transaction.deletedJobs) this.removeJob(id);
    for (const id of transaction.deletedRuns) this.removeRun(id);
    transaction.runs.forEach((run, offset) => this.applyRun(run, file, offset));
    if (transaction.jobOrder)
      this.jobs = orderedJournalRecords(this.jobs, transaction.jobOrder);
    this.applyRunOrder(transaction.runOrder);
  }
  private applyRun(run: SchedulerRun, file: string, offset: number): void {
    const entry: JournalRunEntry = {
      id: run.id,
      jobId: run.jobId,
      sessionId: run.sessionId,
      environmentId: run.environmentId,
      jobRevision: run.jobRevision,
      scheduledAt: run.scheduledAt,
      requestId: run.requestId,
      status: run.status,
      file,
      offset,
    };
    this.updateActiveRun(run, entry);
    this.runs.set(run.id, entry);
  }
  private updateActiveRun(run: SchedulerRun, entry: JournalRunEntry): void {
    if (!isActiveSchedulerRun(run)) {
      this.active.delete(run.id);
      return;
    }
    entry.active = run;
    this.active.set(run.id, run);
  }
  private applyRunOrder(order: string[] | undefined): void {
    if (!order) return;
    this.runs = orderedJournalRecords(this.runs, order);
    this.active = orderedJournalRecords(
      this.active,
      order.filter((id) => this.active.has(id)),
    );
  }
  async snapshot(view?: "active"): Promise<SchedulerSnapshot> {
    return {
      schemaVersion: 1,
      jobs: structuredClone([...this.jobs.values()]),
      runs:
        view === "active"
          ? structuredClone([...this.active.values()])
          : await this.readRuns(),
    };
  }
  async readRuns(
    jobId?: string,
    query?: SchedulerRunListQuery,
  ): Promise<SchedulerRun[]> {
    const selected = querySchedulerRuns([...this.runs.values()], jobId, query);
    const files = new Map<string, Promise<SchedulerTransaction>>();
    const result: SchedulerRun[] = [];
    for (const entry of selected) {
      if (entry.active) {
        result.push(structuredClone(entry.active));
        continue;
      }
      let loading = files.get(entry.file);
      if (!loading) {
        loading = readFile(entry.file, "utf8").then((text) =>
          parseSchedulerTransaction(JSON.parse(text)),
        );
        files.set(entry.file, loading);
      }
      const run = (await loading).runs[entry.offset];
      if (!matchesIndexedJournalRun(run, entry))
        throw new Error("scheduler_store_corrupt");
      result.push(structuredClone(run));
    }
    return result;
  }
  private removeRun(id: string): void {
    this.runs.delete(id);
    this.active.delete(id);
  }
  private removeJob(id: string): void {
    this.jobs.delete(id);
    for (const entry of this.runs.values()) {
      if (entry.jobId === id) this.removeRun(entry.id);
    }
  }
}
export function isActiveSchedulerRun(run: SchedulerRun): boolean {
  return run.status === "pending" || run.status === "running";
}
function orderedJournalRecords<T>(
  records: Map<string, T>,
  order: string[],
): Map<string, T> {
  assertJournalOrder(records, order);
  return new Map(order.map((id) => [id, records.get(id)!]));
}

function assertJournalOrder(
  records: { size: number; has(id: string): boolean },
  order: string[],
): void {
  if (!containsEveryJournalRecord(records, order))
    throw new Error("scheduler_store_corrupt");
}

function containsEveryJournalRecord(
  records: { size: number; has(id: string): boolean },
  order: string[],
): boolean {
  if (order.length !== records.size) return false;
  if (new Set(order).size !== order.length) return false;
  return order.every((id) => records.has(id));
}

function requiresJournalHistoryValidation(
  previous: SchedulerJob | undefined,
  next: SchedulerJob,
): boolean {
  if (!previous) return false;
  if (previous.sessionId !== next.sessionId) return true;
  if (previous.environmentId !== next.environmentId) return true;
  return next.revision < previous.revision;
}

function assertJournalRunOwner(
  run: Pick<SchedulerRun, "sessionId" | "environmentId" | "jobRevision">,
  job: SchedulerJob | undefined,
): void {
  if (!hasConsistentJournalRunOwner(run, job))
    throw new Error("scheduler_store_corrupt");
}

function hasConsistentJournalRunOwner(
  run: Pick<SchedulerRun, "sessionId" | "environmentId" | "jobRevision">,
  job: SchedulerJob | undefined,
): boolean {
  if (!job) return false;
  if (run.sessionId !== job.sessionId) return false;
  if (run.environmentId !== job.environmentId) return false;
  return run.jobRevision <= job.revision;
}
