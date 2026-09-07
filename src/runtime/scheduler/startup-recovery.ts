import type { SchedulerSnapshot } from "./contracts.js";
import { nextSchedulerOccurrence } from "./next-occurrence.js";
import { makeSchedulerRun } from "./run-records.js";

export function recoverSchedulerSnapshot(
  state: SchedulerSnapshot,
  environmentId: string,
  now: number,
): void {
  const at = new Date(now).toISOString();
  for (const job of state.jobs) {
    if (job.environmentId !== environmentId)
      throw new Error("scheduler_environment_mismatch");
  }
  for (const run of state.runs) {
    if (run.status === "running") {
      run.status = "interrupted";
      run.finishedAt = at;
      run.error = "scheduler_process_stopped";
      continue;
    }
    if (run.status !== "pending") continue;
    run.status = "missed";
    run.finishedAt = at;
    run.error = "scheduler_offline_no_catchup";
  }
  for (const job of state.jobs) {
    if (job.state !== "active") continue;
    if (!job.nextRunAt) continue;
    if (Date.parse(job.nextRunAt) > now) continue;
    const missed = makeSchedulerRun(job, job.nextRunAt, "schedule");
    missed.status = "missed";
    missed.finishedAt = at;
    missed.error = "scheduler_offline_no_catchup";
    state.runs.push(missed);
    job.nextRunAt = nextSchedulerOccurrence(job.schedule, job.timeZone, now);
    if (!job.nextRunAt) job.state = "completed";
  }
}
