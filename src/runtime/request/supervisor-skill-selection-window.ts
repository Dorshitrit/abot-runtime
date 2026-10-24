export type SupervisorSkillSelectionWindow = Readonly<{
  isOpen(): boolean;
  complete(): void;
}>;

export type SupervisorSkillSelectionWindows = Readonly<{
  bind(entry: Readonly<{
    rootCallId: string;
    returnedResultRef?: string;
  }>): SupervisorSkillSelectionWindow;
}>;

/**
 * Request-local preparation progress, never session or checkpoint state.
 * A canonical direct-child result identifies a new entry into Supervisor.
 * Repeated activations, steering and reference reads retain the same entry.
 */
export function createSupervisorSkillSelectionWindows(): SupervisorSkillSelectionWindows {
  const completedEntries = new Set<string>();
  return Object.freeze({
    bind(entry): SupervisorSkillSelectionWindow {
      const key = JSON.stringify([entry.rootCallId, entry.returnedResultRef ?? null]);
      return Object.freeze({
        isOpen: () => !completedEntries.has(key),
        complete: () => { completedEntries.add(key); },
      });
    },
  });
}
