import { BASKET_LIMITS } from "./limits.js";

type IdentityOutcome = { identity: string } | { error: unknown };
type IdentityJob = { listeners: Set<(outcome: IdentityOutcome) => void> };

function waitForMetadataEvent<T>(listeners: Set<(value: T) => void>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const detach = () => {
      listeners.delete(complete);
      signal.removeEventListener("abort", abort);
    };
    const complete = (value: T) => { detach(); resolve(value); };
    const abort = () => { detach(); reject(signal.reason); };
    listeners.add(complete);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Physical slots survive caller cancellation; cancelled waiters leave no promise reactions behind. */
export function createBasketMetadataPool(readIdentity: (path: string) => Promise<string>) {
  const active = new Map<string, IdentityJob>();
  const capacity = new Set<(value: undefined) => void>();

  function start(binding: string, path: string): IdentityJob {
    const job: IdentityJob = { listeners: new Set() };
    active.set(binding, job);
    const finish = (outcome: IdentityOutcome) => {
      active.delete(binding);
      for (const listener of [...job.listeners]) listener(outcome);
      for (const listener of [...capacity]) listener(undefined);
    };
    void Promise.resolve().then(() => readIdentity(path)).then(
      identity => finish({ identity }), error => finish({ error }),
    );
    return job;
  }

  return Object.freeze({
    async read(binding: string, path: string, signal: AbortSignal): Promise<string> {
      for (;;) {
        signal.throwIfAborted();
        const existing = active.get(binding);
        if (existing) return unwrap(await waitForMetadataEvent(existing.listeners, signal));
        if (active.size < BASKET_LIMITS.healthConcurrency)
          return unwrap(await waitForMetadataEvent(start(binding, path).listeners, signal));
        await waitForMetadataEvent(capacity, signal);
      }
    },
  });
}

function unwrap(outcome: IdentityOutcome): string {
  if ("error" in outcome) throw outcome.error;
  return outcome.identity;
}
