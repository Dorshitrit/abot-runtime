import type { NotificationIssueOccurrence } from "./issue-contracts.js";
import { issueOccurrenceHash } from "./issue-receipts.js";

export const ISSUE_PENDING_LIMIT = 10_000;

/** Coalesces live observations; a failed batch stays owned here until a later successful flush. */
export class NotificationIssueBatch {
  private readonly pending = new Map<string, NotificationIssueOccurrence[]>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly writing = new Map<string, Promise<void>>();
  private readonly identities = new Set<string>();
  private readonly rejected = new Map<string, number>();

  constructor(private readonly persist: (environmentId: string, items: readonly NotificationIssueOccurrence[]) => Promise<void>,
    private readonly failed: (error: unknown) => void) {}

  enqueue(occurrence: NotificationIssueOccurrence): void {
    const identity = this.identity(occurrence);
    if (this.identities.has(identity)) return;
    const items = this.pending.get(occurrence.environmentId) ?? [];
    if (items.length >= ISSUE_PENDING_LIMIT) {
      const count = Math.min(Number.MAX_SAFE_INTEGER, this.rejectedCount(occurrence.environmentId) + 1);
      this.rejected.set(occurrence.environmentId, count);
      if (count === 1 || Number.isInteger(Math.log2(count)))
        this.failed(new Error(`Notification issue collection queue is full; ${count} observations rejected for ${occurrence.environmentId}.`));
      return;
    }
    this.identities.add(identity);
    items.push(occurrence);
    this.pending.set(occurrence.environmentId, items);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(this.failed); }, 20);
    this.timer.unref?.();
  }

  rejectedCount(environmentId: string): number { return this.rejected.get(environmentId) ?? 0; }

  private identity(occurrence: NotificationIssueOccurrence): string {
    return `${occurrence.environmentId}:${issueOccurrenceHash(occurrence.namespace, occurrence.occurrenceId)}`;
  }

  private flushEnvironment(environmentId: string): Promise<void> {
    const previous = this.writing.get(environmentId) ?? Promise.resolve();
    const writing = previous.catch(() => undefined).then(async () => {
      const items = this.pending.get(environmentId);
      if (!items) return;
      while (items.length) {
        const batch = items.slice(0, 256);
        await this.persist(environmentId, batch);
        items.splice(0, batch.length);
        for (const item of batch) this.identities.delete(this.identity(item));
      }
      this.pending.delete(environmentId);
    });
    this.writing.set(environmentId, writing);
    void writing.finally(() => {
      if (this.writing.get(environmentId) === writing) this.writing.delete(environmentId);
    }).catch(() => undefined);
    return writing;
  }

  async flush(environmentId?: string): Promise<void> {
    if (environmentId !== undefined) return this.flushEnvironment(environmentId);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const environments = new Set([...this.pending.keys(), ...this.writing.keys()]);
    const results = await Promise.allSettled([...environments].map((id) => this.flushEnvironment(id)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      const cause = failures[0].reason;
      throw new AggregateError(failures.map((result) => result.reason),
        `Notification issue collection failed: ${cause instanceof Error ? cause.message : "storage unavailable"}`);
    }
  }
}
