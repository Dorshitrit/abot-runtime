import type { CoWorkerResourceActivity } from "./contracts.js";

type AdmissionRequest = Readonly<{
  activity?: CoWorkerResourceActivity;
  supportsParallel: boolean;
  signal: AbortSignal;
  maximum(): number;
  assertActivityAllowed(): void;
}>;
type WaitingAdmission = {
  request: AdmissionRequest;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  removeAbortListener(): void;
};

// At most eight processing owners, one proactive review and one reassessment.
const MAX_WAITING_ADMISSIONS = 10;

/** Only existing work waits here. Release/abort events drive admission; no timers or retries. */
export class CoWorkerResourceAdmission {
  private active = 0;
  private exclusive = 0;
  private lastActivity: CoWorkerResourceActivity | undefined;
  private readonly waiting: WaitingAdmission[] = [];
  get activeCalls(): number {
    return this.active;
  }

  acquire(request: AdmissionRequest): Promise<() => void> {
    request.signal.throwIfAborted();
    request.assertActivityAllowed();
    if (!request.activity) {
      if (this.waiting.length || !this.hasCapacity(request))
        throw new Error("co_worker_resources_busy");
      return Promise.resolve(this.grant(request));
    }
    if (this.waiting.length >= MAX_WAITING_ADMISSIONS)
      throw new Error("co_worker_resources_busy");
    return new Promise((resolve, reject) => {
      const waiting: WaitingAdmission = {
        request,
        resolve,
        reject,
        removeAbortListener: () =>
          request.signal.removeEventListener("abort", aborted),
      };
      const aborted = () => {
        const index = this.waiting.indexOf(waiting);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        waiting.removeAbortListener();
        reject(
          request.signal.reason ?? new Error("co_worker_resource_wait_aborted"),
        );
        this.drain();
      };
      request.signal.addEventListener("abort", aborted, { once: true });
      this.waiting.push(waiting);
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiting.length) {
      const next = this.nextWaiting();
      try {
        next.request.signal.throwIfAborted();
        next.request.assertActivityAllowed();
        // A waiting exclusive call forms a barrier: cloud work cannot keep overtaking it.
        if (!this.hasCapacity(next.request)) return;
        this.remove(next);
        next.resolve(this.grant(next.request));
      } catch (error) {
        this.remove(next);
        next.reject(error);
      }
    }
  }

  private nextWaiting(): WaitingAdmission {
    return (
      this.waiting.find(
        ({ request }) => request.activity !== this.lastActivity,
      ) ?? this.waiting[0]
    );
  }

  private remove(waiting: WaitingAdmission): void {
    this.waiting.splice(this.waiting.indexOf(waiting), 1);
    waiting.removeAbortListener();
  }

  private hasCapacity(request: AdmissionRequest): boolean {
    if (this.exclusive > 0) return false;
    if (!request.supportsParallel && this.active > 0) return false;
    return this.active < request.maximum();
  }

  private grant(request: AdmissionRequest): () => void {
    this.active += 1;
    if (!request.supportsParallel) this.exclusive += 1;
    if (request.activity) this.lastActivity = request.activity;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      if (!request.supportsParallel) this.exclusive -= 1;
      this.drain();
    };
  }
}
