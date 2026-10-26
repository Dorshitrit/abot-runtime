import type { SchedulerJob } from "./contracts.js";
import { invalidateJob, type SchedulerContext } from "./service-context.js";

export type SchedulerJobMutationGuard = Readonly<{
  sessionId: string;
  expectedRevision: number;
}>;

export function requireSchedulerJobMutationGuard(
  job: SchedulerJob,
  guard?: SchedulerJobMutationGuard,
): void {
  if (!guard) return;
  if (job.sessionId !== guard.sessionId) throw new Error("scheduler_job_not_found");
  if (!Number.isSafeInteger(guard.expectedRevision))
    throw new Error("scheduler_job_revision_conflict");
  if (job.revision !== guard.expectedRevision)
    throw new Error("scheduler_job_revision_conflict");
}

/** Reserve synchronously, but invalidate the epoch only after an atomic target check. */
export function reserveSchedulerJobMutation(
  context: SchedulerContext,
  jobId: string,
  inputGuard?: SchedulerJobMutationGuard,
): Readonly<{ accept(job: SchedulerJob): void; release(): void }> {
  if (!inputGuard) {
    const release = invalidateJob(context, jobId);
    return { accept: () => undefined, release };
  }
  const guard = { ...inputGuard };
  const releaseReservation = context.guardedJobMutations.reserve(jobId, guard);
  let releaseInvalidation: (() => void) | undefined;
  return {
    accept(job) {
      requireSchedulerJobMutationGuard(job, guard);
      releaseInvalidation ??= invalidateJob(context, jobId);
    },
    release() {
      releaseInvalidation?.();
      releaseReservation();
    },
  };
}
