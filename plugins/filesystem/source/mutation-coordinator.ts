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
      if (process.platform === "win32") targetKey = targetKey.toUpperCase();
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
// Public plugins are bundled separately; a module singleton cannot serialize
// writes across those bundles. The versioned process slot owns only the queue.
const COORDINATOR_KEY = Symbol.for("abot.filesystem.mutation-coordinator.v1");
const processState = globalThis as typeof globalThis & {
  [COORDINATOR_KEY]?: FilesystemMutationCoordinator;
};

export function getProcessFilesystemMutationCoordinator(): FilesystemMutationCoordinator {
  return processState[COORDINATOR_KEY] ??=
    createFilesystemMutationCoordinator();
}
