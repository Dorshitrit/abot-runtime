/** Coordinates background admission with requests from every environment caller. */
export class SessionRequestAdmission {
  private readonly active = new Map<string, number>();
  private readonly reserved = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly idleWaiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly isDeleted: (sessionId: string) => boolean) {}

  tryReserve(sessionId: string): (() => void) | null {
    if (this.closed) return null;
    if (this.isDeleted(sessionId)) return null;
    if (this.reserved.has(sessionId)) return null;
    if ((this.active.get(sessionId) ?? 0) > 0) return null;
    this.reserved.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved.delete(sessionId);
      for (const notify of this.waiters.get(sessionId) ?? []) notify();
      this.waiters.delete(sessionId);
      this.notifyIdle();
    };
  }

  async run<T>(sessionId: string, execute: () => Promise<T>): Promise<T> {
    this.requireOpenAdmission();
    while (this.reserved.has(sessionId)) {
      await new Promise<void>((resolve) => {
        const waiting = this.waiters.get(sessionId) ?? new Set();
        waiting.add(resolve);
        this.waiters.set(sessionId, waiting);
      });
      this.requireOpenAdmission();
    }
    if (this.isDeleted(sessionId)) throw new Error("session_deleted");
    this.active.set(sessionId, (this.active.get(sessionId) ?? 0) + 1);
    try {
      return await execute();
    } finally {
      const remaining = (this.active.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.active.set(sessionId, remaining);
      else this.active.delete(sessionId);
      this.notifyIdle();
    }
  }

  close(): void {
    this.closed = true;
    for (const waiting of this.waiters.values()) {
      for (const notify of waiting) notify();
    }
    this.waiters.clear();
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private requireOpenAdmission(): void {
    if (this.closed) throw new Error("runtime_request_admission_closed");
  }

  isIdle(): boolean {
    if (this.active.size > 0) return false;
    return this.reserved.size === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const notify of this.idleWaiters) notify();
    this.idleWaiters.clear();
  }
}
