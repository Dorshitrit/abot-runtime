import { readFile } from "node:fs/promises";
import type { AutomationJournalState } from "../automations/storage-records.js";
import type {
  SchedulerRunListQuery,
  SchedulerSnapshot,
  SchedulerStoredJob,
  SchedulerStoredRun,
} from "./contracts.js";
import {
  isAutomationSchedulerJob,
  isAutomationSchedulerRun,
  schedulerTargetKey,
} from "./scheduler-target.js";
import {
  assertJournalTransactionIds,
  parseSchedulerTransaction,
  type SchedulerTransaction,
} from "./journal-transaction.js";
import { querySchedulerRuns } from "./run-list-query.js";
import { calendarDateAt } from "./calendar-time.js";
import {
  matchesIndexedJournalRun,
  type JournalIndexState,
  type JournalRunEntry,
} from "./journal-index-state.js";
import { JournalAutomationIndex } from "./journal-automation-index.js";
export class SchedulerJournalIndex {
  private jobs = new Map<string, SchedulerStoredJob>();
  private runs = new Map<string, JournalRunEntry>();
  private active = new Map<string, SchedulerStoredRun>();
  private automations: JournalAutomationIndex;

  constructor(state?: JournalIndexState) {
    this.automations = new JournalAutomationIndex(state?.automations);
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
      automations: this.automations.exportState(),
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
    if (transaction.automation)
      this.automations.validate(transaction.automation);
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
    if (transaction.automation)
      this.automations.apply(transaction.automation, file);
  }
  private applyRun(run: SchedulerStoredRun, file: string, offset: number): void {
    const entry: JournalRunEntry = {
      id: run.id,
      jobId: run.jobId,
      environmentId: run.environmentId,
      jobRevision: run.jobRevision,
      scheduledAt: run.scheduledAt,
      status: run.status,
      file,
      offset,
      ...(isAutomationSchedulerRun(run)
        ? { target: run.target, idempotencyKey: run.idempotencyKey,
            admittedAt: run.admittedAt }
        : { sessionId: run.sessionId, requestId: run.requestId }),
    };
    this.updateActiveRun(run, entry);
    this.runs.set(run.id, entry);
  }
  private updateActiveRun(run: SchedulerStoredRun, entry: JournalRunEntry): void {
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
  async readAutomations(): Promise<AutomationJournalState> {
    return this.automations.snapshot();
  }
  async readRuns(
    jobId?: string,
    query?: SchedulerRunListQuery,
    target?: "request" | "automation",
  ): Promise<SchedulerStoredRun[]> {
    const scoped = [...this.runs.values()].filter((entry) => {
      if (!target) return true;
      const kind = entry.target?.kind ?? "request";
      return kind === target;
    });
    const selected = querySchedulerRuns(scoped, jobId, query);
    const files = new Map<string, Promise<SchedulerTransaction>>();
    const result: SchedulerStoredRun[] = [];
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
  async readRun(runId: string): Promise<SchedulerStoredRun | null> {
    const entry = this.runs.get(runId);
    if (!entry) return null;
    if (entry.active) return structuredClone(entry.active);
    const transaction = parseSchedulerTransaction(
      JSON.parse(await readFile(entry.file, "utf8")),
    );
    const run = transaction.runs[entry.offset];
    if (!matchesIndexedJournalRun(run, entry))
      throw new Error("scheduler_store_corrupt");
    return structuredClone(run);
  }
  async readAutomationRunByKey(
    automationId: string,
    idempotencyKey: string,
  ) {
    const entry = [...this.runs.values()].find(
      (item) =>
        item.target?.kind === "automation" &&
        item.target.automationId === automationId &&
        item.idempotencyKey === idempotencyKey,
    );
    if (!entry) return null;
    const run = await this.readRun(entry.id);
    if (!run || !isAutomationSchedulerRun(run))
      throw new Error("scheduler_store_corrupt");
    return run;
  }
  countAutomationRunsOnDay(
    automationId: string,
    timeZone: string,
    at: number,
  ): number {
    const day = calendarDateAt(at, timeZone);
    let count = 0;
    for (const entry of this.runs.values()) {
      if (entry.target?.kind !== "automation" ||
          entry.target.automationId !== automationId ||
          entry.status === "missed") continue;
      const admittedAt = Date.parse(entry.admittedAt ?? entry.scheduledAt);
      if (Math.abs(admittedAt - at) > 48 * 60 * 60_000) continue;
      const admittedDay = calendarDateAt(admittedAt, timeZone);
      if (admittedDay.year === day.year && admittedDay.month === day.month &&
          admittedDay.day === day.day) count += 1;
    }
    return count;
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
export function isActiveSchedulerRun(run: SchedulerStoredRun): boolean {
  if (run.status === "pending" || run.status === "running") return true;
  return run.status === "stopping";
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
  previous: SchedulerStoredJob | undefined,
  next: SchedulerStoredJob,
): boolean {
  if (!previous) return false;
  if (schedulerTargetKey(previous) !== schedulerTargetKey(next)) return true;
  if (previous.environmentId !== next.environmentId) return true;
  return next.revision < previous.revision;
}

function assertJournalRunOwner(
  run: JournalRunEntry | SchedulerStoredRun,
  job: SchedulerStoredJob | undefined,
): void {
  if (!hasConsistentJournalRunOwner(run, job))
    throw new Error("scheduler_store_corrupt");
}

function hasConsistentJournalRunOwner(
  run: JournalRunEntry | SchedulerStoredRun,
  job: SchedulerStoredJob | undefined,
): boolean {
  if (!job) return false;
  if (run.environmentId !== job.environmentId) return false;
  if (run.jobRevision > job.revision) return false;
  if (isAutomationSchedulerJob(job)) {
    if (run.target?.kind !== "automation") return false;
    if (run.target.automationId !== job.target.automationId) return false;
    return run.target.definitionRevision <= job.target.definitionRevision;
  }
  if (run.target?.kind === "automation") return false;
  if (!("sessionId" in run)) return false;
  return run.sessionId === job.sessionId;
}
