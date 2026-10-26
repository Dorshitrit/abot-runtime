import type { SchedulerJobMutationGuard } from "./job-mutation-guard.js";

/** Pending guarded edits block only preparation of their exact current Job revision. */
export class GuardedSchedulerJobMutations {
  private readonly reservations = new Set<Readonly<{
    jobId: string;
    guard: SchedulerJobMutationGuard;
  }>>();

  reserve(jobId: string, guard: SchedulerJobMutationGuard): () => void {
    const reservation = { jobId, guard };
    this.reservations.add(reservation);
    return () => { this.reservations.delete(reservation); };
  }

  hasPending(jobId: string, sessionId: string, revision: number): boolean {
    for (const reservation of this.reservations) {
      if (reservation.jobId !== jobId) continue;
      if (reservation.guard.sessionId !== sessionId) continue;
      if (reservation.guard.expectedRevision === revision) return true;
    }
    return false;
  }
}
