import type { SchedulerStore } from "./contracts.js";

/** Older injected stores may ignore the view and still satisfy the full contract. */
export function createSchedulerWorkingStore(
  store: SchedulerStore,
): SchedulerStore {
  return {
    acquire: () => store.acquire(),
    read: () => store.read("active"),
    update: (mutate) => store.update(mutate, "active"),
  };
}
