import type {
  LongTermMemoryRepository,
  LongTermMemoryRepositorySnapshot,
} from "../../long-term-memory/contracts.js";
import {
  advanceMemorySnapshot,
  createEmptyMemorySnapshot,
} from "../../long-term-memory/repository-state.js";

export function createInMemoryLongTermMemoryRepository(
  initial: LongTermMemoryRepositorySnapshot = createEmptyMemorySnapshot(),
): LongTermMemoryRepository {
  let snapshot = initial;
  let writeTail = Promise.resolve();

  return Object.freeze({
    async read() {
      await writeTail;
      return snapshot;
    },
    async update(mutate) {
      let updated = snapshot;
      const write = writeTail.then(() => {
        updated = advanceMemorySnapshot(snapshot, mutate(snapshot));
        snapshot = updated;
      });
      writeTail = write.catch(() => undefined);
      await write;
      return updated;
    },
  });
}
