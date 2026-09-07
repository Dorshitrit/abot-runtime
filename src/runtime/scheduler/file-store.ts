import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "../adapters/long-term-memory/file-lock/acquisition.js";
import type { SchedulerStore } from "./contracts.js";
import { SchedulerJournalStore } from "./journal-store.js";
import { journalReadIdentity, readJournalHead } from "./journal-head.js";

export function createFileSchedulerStore(directory: string): SchedulerStore {
  let releaseOwner: (() => Promise<void>) | undefined;
  let journal: SchedulerJournalStore | undefined;
  let transactionTail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const transaction = transactionTail.then(operation);
    transactionTail = transaction.catch(() => undefined);
    return transaction;
  };
  const readJournal = async <T>(
    read: (store: SchedulerJournalStore) => Promise<T>,
  ): Promise<T> => {
    if (journal) return read(journal);
    // Unowned readers have no cached lease. A retired immutable generation is
    // retried only when its authoritative pointer changed during this read.
    for (;;) {
      const before = journalReadIdentity(await readJournalHead(directory));
      const [result] = await Promise.allSettled([
        new SchedulerJournalStore(directory).load().then(read),
      ]);
      if (before !== journalReadIdentity(await readJournalHead(directory)))
        continue;
      if (result.status === "rejected") throw result.reason;
      return result.value;
    }
  };
  return {
    acquire: async () => {
      if (releaseOwner) throw new Error("scheduler_store_in_use");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        releaseOwner = await acquireFileLock(
          join(directory, "scheduler.owner"),
          { waitMs: 0 },
        );
      } catch (error) {
        if (isOwnerContention(error)) throw new Error("scheduler_store_in_use");
        throw error;
      }
      try {
        journal = await new SchedulerJournalStore(directory).load();
        await journal.prepareOwned();
      } catch (error) {
        const release = releaseOwner;
        releaseOwner = undefined;
        journal = undefined;
        await release();
        throw error;
      }
      return async () => {
        await transactionTail;
        const release = releaseOwner;
        releaseOwner = undefined;
        journal = undefined;
        await release?.();
      };
    },
    read: (view) => enqueue(() => readJournal((store) => store.snapshot(view))),
    readRuns: (jobId, query) =>
      enqueue(() => readJournal((store) => store.readRuns(jobId, query))),
    update: (mutate, view) =>
      enqueue(async () => {
        if (!releaseOwner || !journal)
          throw new Error("scheduler_store_not_owned");
        return journal.update(mutate, view);
      }),
  };
}
function isOwnerContention(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "long_term_memory_store_lock_timeout"
  );
}
