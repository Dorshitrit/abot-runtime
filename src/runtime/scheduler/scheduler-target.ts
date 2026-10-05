import type {
  SchedulerAutomationJob,
  SchedulerAutomationRun,
  SchedulerJob,
  SchedulerRun,
  SchedulerStoredJob,
  SchedulerStoredRun,
} from "./contracts.js";

export function isAutomationSchedulerJob(
  job: SchedulerStoredJob,
): job is SchedulerAutomationJob {
  return job.target?.kind === "automation";
}

export function isRequestSchedulerJob(
  job: SchedulerStoredJob,
): job is SchedulerJob {
  return !isAutomationSchedulerJob(job);
}

export function isAutomationSchedulerRun(
  run: SchedulerStoredRun,
): run is SchedulerAutomationRun {
  return run.target?.kind === "automation";
}

export function isRequestSchedulerRun(
  run: SchedulerStoredRun,
): run is SchedulerRun {
  return !isAutomationSchedulerRun(run);
}

export function requireRequestSchedulerJob(
  job: SchedulerStoredJob,
): SchedulerJob {
  if (!isRequestSchedulerJob(job)) throw new Error("scheduler_request_job_required");
  return job;
}

export function requireRequestSchedulerRun(
  run: SchedulerStoredRun,
): SchedulerRun {
  if (!isRequestSchedulerRun(run)) throw new Error("scheduler_request_run_required");
  return run;
}

export function sameSchedulerTarget(
  job: SchedulerStoredJob,
  run: SchedulerStoredRun,
): boolean {
  if (isAutomationSchedulerJob(job)) {
    if (!isAutomationSchedulerRun(run)) return false;
    if (job.target.automationId !== run.target.automationId) return false;
    return run.target.definitionRevision <= job.target.definitionRevision;
  }
  if (!isRequestSchedulerRun(run)) return false;
  return job.sessionId === run.sessionId;
}

export function schedulerTargetKey(
  value: SchedulerStoredJob | SchedulerStoredRun,
): string {
  if (value.target?.kind === "automation")
    return `automation:${value.target.automationId}`;
  if (!("sessionId" in value)) throw new Error("scheduler_store_corrupt");
  return `session:${value.sessionId}`;
}
