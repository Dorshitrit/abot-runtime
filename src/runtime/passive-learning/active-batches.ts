import { processLearningBatch } from "./process-batch.js";
import { isLearningApplicationExcluded } from "./application-policy.js";

/** Owns cancellation and settlement for admitted learning batches, not scheduling. */
export class LearningActiveBatches {
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void>; apps: readonly string[] }>();
  get size(): number { return this.active.size; }
  has(id: string): boolean { return this.active.has(id); }

  dispatch(options: Omit<Parameters<typeof processLearningBatch>[0], "signal">, settled: () => void): void {
    const abort = new AbortController();
    const promise = processLearningBatch({ ...options, signal: abort.signal }).finally(() => {
      this.active.delete(options.batch.id);
      settled();
    });
    this.active.set(options.batch.id, { abort, promise, apps: options.batch.observations.map((item) => item.source.app) });
  }
  async settle(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map(({ promise }) => promise));
  }
  abort(reason: string): void {
    for (const work of this.active.values()) work.abort.abort(new Error(reason));
  }
  async excludeApplications(exclusions: readonly string[]): Promise<void> {
    const affected = [...this.active.values()].filter((work) =>
      work.apps.some((app) => isLearningApplicationExcluded(app, exclusions)));
    for (const work of affected) work.abort.abort(new Error("learning_application_processing_excluded"));
    await Promise.allSettled(affected.map((work) => work.promise));
  }
}
