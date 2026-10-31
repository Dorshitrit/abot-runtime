/** Keeps accepted RPC effects under the owner's lease until they settle. */
export class LocalRuntimeOwnerActivity {
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;
  private exclusive = false;

  assertAcceptingRequests(): void {
    if (this.stopped) throw new Error("local_runtime_owner_stopped");
    if (this.exclusive) throw new Error("runtime_maintenance_busy");
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAcceptingRequests();
    const pending = operation();
    this.active.add(pending);
    try {
      return await pending;
    } finally {
      this.active.delete(pending);
    }
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAcceptingRequests();
    if (!this.isIdle()) throw new Error("runtime_maintenance_busy");
    this.exclusive = true;
    const pending = Promise.resolve().then(operation);
    this.active.add(pending);
    try { return await pending; }
    finally {
      this.active.delete(pending);
      this.exclusive = false;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  isIdle(): boolean {
    return this.active.size === 0;
  }

  async whenIdle(): Promise<void> {
    // stop closes intake synchronously before the transport asks for this fence.
    await Promise.allSettled([...this.active]);
  }
}
