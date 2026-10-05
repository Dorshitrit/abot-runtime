import type { AutomationPersistence } from "./persistence.js";
import type { AutomationResultStore } from "./result-store.js";
import type { AutomationResultRecord } from "./storage-records.js";

/** File cleanup requires a readable durable head, including after uncertain publication. */
export async function publishAutomationResult<T>(options: {
  persistence: AutomationPersistence;
  results: AutomationResultStore;
  record: AutomationResultRecord;
  publish(): Promise<T>;
}): Promise<T> {
  try {
    return await options.publish();
  } catch (error) {
    const state = await options.persistence.read().catch(() => undefined);
    // A visible manifest may contain this record even when its directory sync
    // failed. The poisoned journal refuses reads until durable reacquisition.
    const definitelyUncommitted = state &&
      !state.results.some((record) => record.id === options.record.id);
    if (definitelyUncommitted)
      await options.results.discardUncommitted(options.record).catch(() => undefined);
    throw error;
  } finally {
    // An unreadable head leaves bytes on disk, but not permanently active in
    // memory. Existing maintenance reconciles them after reacquisition.
    await options.results.releasePublication(options.record);
  }
}
