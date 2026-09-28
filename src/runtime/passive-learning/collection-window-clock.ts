import { nextSchedulerOccurrence } from "../scheduler/next-occurrence.js";
import { isWithinAnalysisWindow } from "./analysis-schedule.js";
import type { LearningAnalysisWindow } from "./contracts.js";

export function nextCollectionWindowBoundary(now: number, window?: LearningAnalysisWindow | null): number | undefined {
  if (!window || window.start === window.end) return undefined;
  const next = [window.start, window.end].flatMap((at) => {
    const occurrence = nextSchedulerOccurrence({ kind: "daily", at }, window.timeZone, now);
    return occurrence ? [Date.parse(occurrence)] : [];
  });
  return next.length ? Math.min(...next) : undefined;
}

/** A single native lease follows actual window transitions even without observations. */
export class CollectionWindowClock {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private opened = false;
  scheduledAt: number | undefined;
  constructor(private readonly options: Readonly<{
    enabled(): boolean;
    window(): LearningAnalysisWindow | null | undefined;
    now(): number;
    open(): Promise<void>;
    close(): void;
    boundary(): void;
  }>) {}

  async synchronize(forceReconnect = false): Promise<void> {
    this.clearTimer();
    if (!this.options.enabled()) { this.close(); return; }
    const now = this.options.now();
    const window = this.options.window();
    this.scheduledAt = nextCollectionWindowBoundary(now, window);
    if (this.scheduledAt !== undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.scheduledAt = undefined;
        this.options.boundary();
      }, Math.max(1, this.scheduledAt - now));
      this.timer.unref?.();
    }
    if (!isWithinAnalysisWindow(now, window)) { this.close(); return; }
    if (this.opened && !forceReconnect) return;
    this.opened = true;
    await this.options.open();
  }
  stop(): void { this.clearTimer(); this.close(); }
  private close(): void { this.opened = false; this.options.close(); }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduledAt = undefined;
  }
}
