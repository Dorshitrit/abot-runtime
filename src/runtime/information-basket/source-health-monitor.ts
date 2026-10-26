import type { BasketSourceHealth } from "./source-health.js";
import { hasReadyBasketFile } from "./source-health.js";
import { BASKET_LIMITS } from "./limits.js";
import type { BasketStateOwner } from "./state-owner.js";

/** At most one environment sweep, independent of model turns and UI refresh frequency. */
export function createBasketSourceHealthMonitor(state: BasketStateOwner, health: BasketSourceHealth) {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: { controller: AbortController; promise: Promise<void> } | undefined;
  let unsubscribe: (() => void) | undefined;

  function schedule(): void {
    if (!running || timer || active) return;
    timer = setTimeout(() => { timer = undefined; wake(); }, BASKET_LIMITS.healthIntervalMs);
    timer.unref();
  }

  function wake(): void {
    if (!running || active) return;
    const controller = new AbortController();
    const job = { controller, promise: Promise.resolve() };
    active = job;
    job.promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const snapshot = await state.read();
      if (!snapshot.settings.enabled || !snapshot.settings.embeddingProfileId) return;
      await health.validate(snapshot.sources.filter(hasReadyBasketFile), controller.signal);
    }).catch(() => {
      // Optional health work cannot fail a request; selected search/list also validate before exposure.
    }).finally(() => {
      if (active === job) active = undefined;
      schedule();
    });
  }

  return Object.freeze({
    start() {
      if (running) return;
      running = true;
      unsubscribe = state.subscribeChanges(change => {
        if (!change.settingsChanged) return;
        active?.controller.abort();
      });
      wake();
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      active?.controller.abort();
      await active?.promise;
    },
  });
}
