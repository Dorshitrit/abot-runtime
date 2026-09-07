/** Keeps accepted RPC effects under the owner's lease until they settle. */
export class LocalRuntimeOwnerActivity {
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;

  assertAcceptingRequests(): void {
    if (this.stopped) throw new Error("local_runtime_owner_stopped");
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
