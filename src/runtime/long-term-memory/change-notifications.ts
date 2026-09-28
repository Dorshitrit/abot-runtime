import type { LongTermMemoryRepository } from "./contracts.js";

/** Invalidates consumers after a committed knowledge change, including detached saves. */
export function observeMemoryChanges(base: LongTermMemoryRepository) {
  const listeners = new Set<() => void>();
  const commitListeners = new Set<(policyChanged: boolean) => void>();
  const repository: LongTermMemoryRepository = {
    read: () => base.read(),
    async update(mutate) {
      let before: number | undefined;
      let previousPolicy: string | undefined;
      const result = await base.update((current) => {
        before = current.knowledgeRevision ?? current.revision;
        previousPolicy = JSON.stringify(current.maturationPolicy);
        return mutate(current);
      });
      const policyChanged = previousPolicy !== JSON.stringify(result.maturationPolicy);
      for (const listener of commitListeners) {
        try { listener(policyChanged); } catch { /* Maintenance cannot undo committed memory. */ }
      }
      const after = result.knowledgeRevision ?? result.revision;
      if (before !== after) {
        for (const listener of listeners) {
          try { listener(); } catch { /* An observer cannot undo committed memory. */ }
        }
      }
      return result;
    },
  };
  return {
    repository,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeCommits(listener: (policyChanged: boolean) => void): () => void {
      commitListeners.add(listener);
      return () => { commitListeners.delete(listener); };
    },
  };
}
