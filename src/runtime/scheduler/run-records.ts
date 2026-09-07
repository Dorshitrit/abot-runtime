import { randomUUID } from "node:crypto";
import type {
  SchedulerJob,
  SchedulerRun,
  SchedulerSnapshot,
} from "./contracts.js";

export function makeSchedulerRun(
  job: SchedulerJob,
  scheduledAt: string,
  trigger: SchedulerRun["trigger"],
): SchedulerRun {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    jobId: job.id,
    environmentId: job.environmentId,
    sessionId: job.sessionId,
    title: job.title,
    prompt: job.prompt,
    modelProfileId: job.modelProfileId,
    agentMode: job.agentMode,
    timeZone: job.timeZone,
    jobRevision: job.revision,
    scheduledAt,
    trigger,
    status: "pending",
  };
}
export function findPendingRun(
  state: SchedulerSnapshot,
  jobId: string,
): SchedulerRun | undefined {
  return state.runs.find(
    (run) => run.jobId === jobId && run.status === "pending",
  );
}
export function cancelPendingRuns(
  state: SchedulerSnapshot,
  jobId: string,
  at: string,
): void {
  for (const run of state.runs) {
    if (run.jobId !== jobId) continue;
    if (run.status !== "pending") continue;
    run.status = "cancelled";
    run.finishedAt = at;
  }
}
export function requireSchedulerJob(
  state: SchedulerSnapshot,
  jobId: string,
): SchedulerJob {
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error("scheduler_job_not_found");
  return job;
}
export function hasRunningSession(
  state: SchedulerSnapshot,
  sessionId: string,
): boolean {
  return state.runs.some(
    (run) => run.sessionId === sessionId && run.status === "running",
  );
}
