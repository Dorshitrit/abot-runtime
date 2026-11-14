import { mergePendingRequestSnapshot } from "../../shared/request-event-snapshots.js";

type PendingEvent = { payload: Record<string, unknown> };

/** Serial writes with one replaceable snapshot at the pending tail. */
export class RequestEventWriteQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending: PendingEvent | undefined;

  constructor(
    private readonly write: (payload: Record<string, unknown>) => Promise<unknown>,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(payload: Record<string, unknown>): void {
    if (this.coalescePendingSnapshot(payload)) return;
    const entry = { payload };
    this.pending = entry;
    this.tail = this.tail.then(async () => {
      if (this.pending === entry) this.pending = undefined;
      await this.write(entry.payload);
    }).catch(this.onError);
  }

  drain(): Promise<void> {
    return this.tail;
  }

  /** Lifecycle commits reserve the same order and cannot be crossed by coalescing. */
  runBarrier<T>(operation: () => Promise<T>): Promise<T> {
    this.pending = undefined;
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private coalescePendingSnapshot(payload: Record<string, unknown>): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const merged = mergePendingRequestSnapshot(pending.payload, payload);
    if (!merged) return false;
    pending.payload = merged;
    return true;
  }
}
