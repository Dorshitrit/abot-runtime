import type {
  SchedulerSnapshot,
  SchedulerStore,
} from "../scheduler/contracts.js";
import type { AutomationJournalState } from "./storage-records.js";

/** One durable owner: this facade delegates to the scheduler journal and lease. */
export function createAutomationPersistence(store: SchedulerStore) {
  const read = store.readAutomations?.bind(store);
  const update = store.updateAutomations?.bind(store);
  const updateWithScheduler = store.updateWithAutomations?.bind(store);
  if (!read || !update || !updateWithScheduler)
    throw new Error("automation_store_unavailable");
  return {
    read: (): Promise<AutomationJournalState> => read(),
    update: <T>(mutate: (state: AutomationJournalState) => T): Promise<T> =>
      update(mutate),
    updateWithScheduler: <T>(
      mutate: (
        scheduler: SchedulerSnapshot,
        automations: AutomationJournalState,
      ) => T,
    ): Promise<T> => updateWithScheduler(mutate),
  };
}

export type AutomationPersistence = ReturnType<
  typeof createAutomationPersistence
>;
