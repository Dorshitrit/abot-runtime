import { InformationBasketError } from "./contracts.js";

/** Environment lifetime only. Never registers work against a request's quiescence. */
export function createBasketServiceWork() {
  let controller = new AbortController();
  let stopped = false;
  const pending = new Set<Promise<unknown>>();
  return Object.freeze({
    run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (stopped) return Promise.reject(new InformationBasketError("basket_service_stopped", undefined, 503));
      const bound = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const work = operation(bound);
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => undefined);
      return work;
    },
    start() {
      if (!stopped) return;
      controller = new AbortController();
      stopped = false;
    },
    async stop() {
      stopped = true;
      controller.abort(new InformationBasketError("basket_service_stopped", undefined, 503));
      await Promise.allSettled([...pending]);
    },
  });
}
