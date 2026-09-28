import { nextAnalysisInstant } from "./analysis-schedule.js";
import type { LearningAnalysisWindow } from "./contracts.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Cadence survives collection changes; pausing analysis only disarms its timer. */
export class LearningAnalysisClock {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextCycleAt: number | undefined;
  scheduledAt: number | undefined;

  constructor(private readonly run: () => void, private readonly now: () => number = Date.now) {}

  dispatched(now: number, interval: number): void {
    this.nextCycleAt = now + interval;
  }

  arm(
    now: number,
    interval: number,
    window?: LearningAnalysisWindow | null,
    earliest?: number,
  ): void {
    if (this.timer) return;
    if (earliest !== undefined && !Number.isFinite(earliest)) return;
    this.nextCycleAt ??= now + interval;
    this.scheduledAt = nextAnalysisInstant(
      Math.max(now, this.nextCycleAt, earliest ?? now),
      window,
    );
    this.schedule(now);
  }

  private schedule(now: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.scheduledAt !== undefined && this.scheduledAt > this.now()) {
        this.schedule(this.now());
        return;
      }
      this.scheduledAt = undefined;
      this.run();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(1, this.scheduledAt! - now)));
    this.timer.unref?.();
  }

  clear(resetCycle = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduledAt = undefined;
    if (resetCycle) this.nextCycleAt = undefined;
  }
}
