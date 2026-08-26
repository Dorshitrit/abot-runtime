export type FilesystemMutationCoordinator = Readonly<{
  runExclusive<T>(targetKey: string, task: () => Promise<T>): Promise<T>;
}>;

function createFilesystemMutationCoordinator(): FilesystemMutationCoordinator {
  const tails = new Map<string, Promise<void>>();

  return Object.freeze({
    async runExclusive<T>(
      targetKey: string,
      task: () => Promise<T>,
    ): Promise<T> {
      const previous = tails.get(targetKey) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(targetKey, current);
      await previous;
      try {
        return await task();
      } finally {
        release();
        if (tails.get(targetKey) === current) tails.delete(targetKey);
      }
    },
  });
}

// Coordination is owned by the filesystem plugin but shared by every plugin
// instance loaded in this process so two handlers cannot mutate one target
// from stale observations.
const PROCESS_MUTATION_COORDINATOR = createFilesystemMutationCoordinator();

export function getProcessFilesystemMutationCoordinator(): FilesystemMutationCoordinator {
  return PROCESS_MUTATION_COORDINATOR;
}
