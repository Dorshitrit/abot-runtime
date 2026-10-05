import type {
  SchedulerAutomationJob,
  SchedulerAutomationRun,
  SchedulerSnapshot,
} from "./contracts.js";
import {
  isAutomationSchedulerJob,
  isAutomationSchedulerRun,
} from "./scheduler-target.js";

export function makeAutomationSchedulerRun(
  job: SchedulerAutomationJob,
  id: string,
  scheduledAt: string,
  trigger: SchedulerAutomationRun["trigger"],
  idempotencyKey?: string,
  admittedAt?: string,
): SchedulerAutomationRun {
  return {
    id,
    jobId: job.id,
    environmentId: job.environmentId,
    target: { ...job.target },
    title: job.title,
    timeZone: job.timeZone,
    jobRevision: job.revision,
    scheduledAt,
    admittedAt: admittedAt ?? scheduledAt,
    trigger,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    status: "pending",
  };
}

export function findPendingAutomationRun(
  state: SchedulerSnapshot,
  jobId: string,
): SchedulerAutomationRun | undefined {
  return state.runs.find(
    (run): run is SchedulerAutomationRun =>
      isAutomationSchedulerRun(run) &&
      run.jobId === jobId &&
      run.status === "pending",
  );
}

export function hasActiveAutomationRun(
  state: SchedulerSnapshot,
  automationId: string,
): boolean {
  return state.runs.some((run) => {
    if (!isAutomationSchedulerRun(run)) return false;
    if (run.target.automationId !== automationId) return false;
    return ["pending", "running", "stopping"].includes(run.status);
  });
}

export function requireAutomationSchedulerJob(
  state: SchedulerSnapshot,
  jobId: string,
): SchedulerAutomationJob {
  const job = state.jobs.find(
    (candidate): candidate is SchedulerAutomationJob =>
      isAutomationSchedulerJob(candidate) && candidate.id === jobId,
  );
  if (!job) throw new Error("automation_job_not_found");
  return job;
}
