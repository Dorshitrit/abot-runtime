import type { ToolUnderlyingSettlement } from "../../capabilities/tool-types.js";

export type AutomationObservedToolSettlement = Readonly<{
  invocationId: string;
  settlement: ToolUnderlyingSettlement;
}>;

export type AutomationToolLifetimes = Readonly<{
  holdEffectAdmission(runId: string, signal: AbortSignal): () => void;
  runInvocation<T>(runId: string, signal: AbortSignal, invoke: () => Promise<T>): Promise<T>;
  observe(
    runId: string,
    invocationId: string,
    settled: Promise<ToolUnderlyingSettlement>,
  ): void;
  whenSettled(runId: string): Promise<readonly AutomationObservedToolSettlement[]>;
}>;

/** Retains durable admissions and actual Tool promises beyond an abort-raced result. */
export function createAutomationToolLifetimes(): AutomationToolLifetimes {
  const pending = new Map<string, Set<Promise<void>>>();
  const observed = new Map<string, AutomationObservedToolSettlement[]>();

  function trackPending(runId: string, tracked: Promise<void>): void {
    const held = pending.get(runId) ?? new Set<Promise<void>>();
    held.add(tracked);
    pending.set(runId, held);
    void tracked.then(() => {
      held.delete(tracked);
      if (held.size === 0 && pending.get(runId) === held) pending.delete(runId);
    });
  }

  return {
    holdEffectAdmission(runId, signal) {
      signal.throwIfAborted();
      let release!: () => void;
      const receipt = new Promise<void>((resolve) => { release = resolve; });
      // Register before durable admission can await; terminal draining must also
      // retain an admitted operation that was cancelled before Tool dispatch.
      trackPending(runId, receipt);
      return release;
    },
    async runInvocation<T>(runId: string, signal: AbortSignal, invoke: () => Promise<T>): Promise<T> {
      // No await between the fence, dispatch, and registration: draining cannot
      // miss a Tool that was admitted before a terminal deadline.
      signal.throwIfAborted();
      const result = invoke();
      trackPending(runId, result.then(() => undefined, () => undefined));
      return result;
    },
    observe(runId, invocationId, settled) {
      const tracked = settled.then(
        (settlement) => {
          const records = observed.get(runId) ?? [];
          records.push({ invocationId, settlement });
          observed.set(runId, records);
        },
        () => {
          const records = observed.get(runId) ?? [];
          records.push({ invocationId, settlement: {
            status: "rejected", errorCode: "tool_execution_failed",
          } });
          observed.set(runId, records);
        },
      );
      trackPending(runId, tracked);
    },
    async whenSettled(runId) {
      while (pending.get(runId)?.size) {
        await Promise.all(pending.get(runId)!);
      }
      const records = observed.get(runId) ?? [];
      observed.delete(runId);
      return records;
    },
  };
}
