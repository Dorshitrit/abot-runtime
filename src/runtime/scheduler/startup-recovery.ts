import type { SchedulerSnapshot } from "./contracts.js";
import { randomUUID } from "node:crypto";
import { makeAutomationSchedulerRun } from "./automation-run-records.js";
import { nextSchedulerOccurrence } from "./next-occurrence.js";
import { makeSchedulerRun } from "./run-records.js";
import {
  isAutomationSchedulerJob,
  isAutomationSchedulerRun,
} from "./scheduler-target.js";

export function recoverSchedulerSnapshot(
  state: SchedulerSnapshot,
  environmentId: string,
  now: number,
): string[] {
  const at = new Date(now).toISOString();
  const recoveredAutomationRuns: string[] = [];
  for (const job of state.jobs) {
    if (job.environmentId !== environmentId)
      throw new Error("scheduler_environment_mismatch");
  }
  for (const run of state.runs) {
    if (run.status === "running" || run.status === "stopping") {
      run.status = "interrupted";
      run.finishedAt = at;
      run.error = "scheduler_process_stopped";
      if (isAutomationSchedulerRun(run)) recoveredAutomationRuns.push(run.id);
      continue;
    }
    if (run.status !== "pending") continue;
    run.status = "missed";
    run.finishedAt = at;
    run.error = "scheduler_offline_no_catchup";
    if (isAutomationSchedulerRun(run)) recoveredAutomationRuns.push(run.id);
  }
  for (const job of state.jobs) {
    if (job.state !== "active") continue;
    if (!job.nextRunAt) continue;
    if (Date.parse(job.nextRunAt) > now) continue;
    const missed = isAutomationSchedulerJob(job)
      ? makeAutomationSchedulerRun(job, randomUUID(), job.nextRunAt, "schedule")
      : makeSchedulerRun(job, job.nextRunAt, "schedule");
    missed.status = "missed";
    missed.finishedAt = at;
    missed.error = "scheduler_offline_no_catchup";
    state.runs.push(missed);
    if (isAutomationSchedulerRun(missed))
      recoveredAutomationRuns.push(missed.id);
    job.nextRunAt = nextSchedulerOccurrence(job.schedule, job.timeZone, now);
    if (!job.nextRunAt) job.state = "completed";
  }
  return recoveredAutomationRuns;
}
