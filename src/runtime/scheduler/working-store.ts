import type { SchedulerStore } from "./contracts.js";

/** Older injected stores may ignore the view and still satisfy the full contract. */
export function createSchedulerWorkingStore(
  store: SchedulerStore,
): SchedulerStore {
  return {
    acquire: () => store.acquire(),
    read: () => store.read("active"),
    readRun: store.readRun?.bind(store),
    readAutomationRunByKey: store.readAutomationRunByKey?.bind(store),
    countAutomationRunsOnDay: store.countAutomationRunsOnDay?.bind(store),
    update: (mutate) => store.update(mutate, "active"),
    readAutomations: store.readAutomations?.bind(store),
    updateAutomations: store.updateAutomations?.bind(store),
    updateWithAutomations: store.updateWithAutomations
      ? (mutate) => store.updateWithAutomations!(mutate, "active")
      : undefined,
  };
}
