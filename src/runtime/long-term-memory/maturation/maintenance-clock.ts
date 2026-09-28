import type { LearningMemoryMaintenance, LearningMemoryService, MaturationPolicy } from "./contracts.js";

type MaintenanceClockOptions = Readonly<{
  memory: Pick<LearningMemoryService, "maintenance" | "nextExpiryAt">;
  policy(): MaturationPolicy | Promise<MaturationPolicy>;
  now?: () => number;
  changed?(result: LearningMemoryMaintenance): void;
  failed?(error: unknown): void;
  refreshed?(): void;
}>;

// Node clamps larger setTimeout delays to 1 ms; long candidate retention must not spin.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** One actual retention deadline, independent of collection/model activity switches. */
export class LearningMaintenanceClock {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private refreshRequested = false;
  private policyChanged = false;
  private refreshTask: Promise<void> | undefined;
  scheduledAt: number | undefined;

  constructor(private readonly options: MaintenanceClockOptions) {}

  start(): Promise<void> {
    if (this.started) return this.refreshTask ?? Promise.resolve();
    this.started = true;
    return this.requestRefresh(false);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.refreshRequested = false;
    this.policyChanged = false;
    this.clearTimer();
    await this.refreshTask;
  }

  preferencesChanged(): Promise<void> { return this.requestRefresh(true); }
  knowledgeChanged(): Promise<void> { return this.requestRefresh(false); }

  private requestRefresh(policyChanged: boolean): Promise<void> {
    if (!this.started) return Promise.resolve();
    this.refreshRequested = true;
    this.policyChanged ||= policyChanged;
    this.refreshTask ??= this.drain().finally(() => {
      this.refreshTask = undefined;
      if (this.refreshRequested) void this.requestRefresh(false);
    });
    return this.refreshTask;
  }

  private async drain(): Promise<void> {
    try {
      while (this.started && this.refreshRequested) {
        this.refreshRequested = false;
        const enforcePolicy = this.policyChanged;
        this.policyChanged = false;
        await this.refreshDeadline(enforcePolicy);
      }
    } catch (error) {
      this.refreshRequested = false;
      this.clearTimer();
      this.options.failed?.(error);
    }
  }

  private async refreshDeadline(enforcePolicy: boolean): Promise<void> {
    this.clearTimer();
    const policy = await this.options.policy();
    if (!this.started) return;
    let nextExpiryAt = await this.options.memory.nextExpiryAt(policy);
    if (!this.started) return;
    if (requiresRetentionMaintenance(nextExpiryAt, enforcePolicy, this.now())) {
      const maintainedAt = this.now();
      const result = await this.options.memory.maintenance(policy);
      if (!this.started) return;
      nextExpiryAt = result.nextExpiryAt;
      if (hasUnadvancedRetentionDeadline(nextExpiryAt, maintainedAt))
        throw new Error("learning_maintenance_deadline_not_advanced");
      if (hasRemovedLearningState(result)) this.options.changed?.(result);
    }
    this.arm(nextExpiryAt);
    this.options.refreshed?.();
  }

  private arm(nextExpiryAt: string | null): void {
    if (!this.started || nextExpiryAt === null) return;
    const deadline = Date.parse(nextExpiryAt);
    if (!Number.isFinite(deadline)) throw new Error("learning_maintenance_deadline_invalid");
    const delay = Math.max(1, deadline - this.now());
    this.scheduledAt = deadline;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scheduledAt = undefined;
      void this.requestRefresh(false);
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduledAt = undefined;
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
}

function requiresRetentionMaintenance(nextExpiryAt: string | null, enforcePolicy: boolean, now: number): boolean {
  if (enforcePolicy) return true;
  if (nextExpiryAt === null) return false;
  return Date.parse(nextExpiryAt) <= now;
}

function hasRemovedLearningState(result: LearningMemoryMaintenance): boolean {
  if (result.removedCandidateCount > 0) return true;
  return result.removedReceiptCount > 0;
}

function hasUnadvancedRetentionDeadline(nextExpiryAt: string | null, maintainedAt: number): boolean {
  if (nextExpiryAt === null) return false;
  return Date.parse(nextExpiryAt) <= maintainedAt;
}
