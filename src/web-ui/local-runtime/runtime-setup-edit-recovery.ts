import { lstatSync, realpathSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withFileLock } from "../../runtime/adapters/long-term-memory/file-lock.js";
import { CONFIG_FILE_LOCK_OPTIONS } from "../../runtime/adapters/config-file-transaction.js";
import {
  isMissingSetupEditFile,
  readSetupEditFile,
  requireSetupEditFileSnapshot,
  restoreSetupEditFile,
  setupEditFileMatches,
  setupEditRecoveryRequired,
  setupEditTextSnapshot,
  syncSetupEditDirectory,
} from "./runtime-setup-edit-files.js";
import {
  readSetupEditJournal,
  setupEditJournalPath,
  type SetupEditJournal,
} from "./runtime-setup-edit-journal.js";

/** Synchronous consumers must not observe any part of an unresolved edit. */
export function requireRuntimeSetupEditSettled(rootDir: string): void {
  let path = resolve(rootDir);
  try {
    path = realpathSync(path);
    lstatSync(setupEditJournalPath(path));
  } catch (error) {
    if (isMissingSetupEditFile(error)) return;
    throw setupEditRecoveryRequired();
  }
  throw setupEditRecoveryRequired();
}

async function requireRecoverableSetupEditFiles(
  journal: SetupEditJournal,
): Promise<void> {
  for (const file of journal.files) {
    const current = await readSetupEditFile(file.path);
    if (setupEditFileMatches(current, file.after)) continue;
    if (
      journal.phase === "pending" &&
      setupEditFileMatches(current, file.before)
    )
      continue;
    throw setupEditRecoveryRequired();
  }
}

/** Caller holds every participant lock; repeatable after interruption at any restore. */
export async function reconcileSetupEditJournal(
  journal: SetupEditJournal,
): Promise<void> {
  await requireRecoverableSetupEditFiles(journal);
  if (journal.phase === "pending") {
    for (const file of [...journal.files].reverse()) {
      const current = await readSetupEditFile(file.path);
      if (setupEditFileMatches(current, file.before)) continue;
      if (!setupEditFileMatches(current, file.after))
        throw setupEditRecoveryRequired();
      await restoreSetupEditFile(file.path, file.after, file.before);
    }
  }
  const path = setupEditJournalPath(journal.rootDir);
  await requireSetupEditFileSnapshot(
    path,
    setupEditTextSnapshot(JSON.stringify(journal) + "\n", 0o600),
  );
  await rm(path);
  await syncSetupEditDirectory(journal.rootDir);
}

async function withSetupEditRecoveryLocks<T>(
  journal: SetupEditJournal,
  operation: () => Promise<T>,
): Promise<T> {
  const [model, config, receipt] = journal.files;
  const locks = [
    config.path + ".config.lock",
    model.path + ".config.lock",
    join(journal.rootDir, ".env.credentials.lock"),
    receipt.path + ".config.lock",
  ];
  const acquire = (index: number): Promise<T> => {
    if (index === locks.length) return operation();
    return withFileLock(
      locks[index],
      () => acquire(index + 1),
      CONFIG_FILE_LOCK_OPTIONS,
    );
  };
  return acquire(0);
}

/** Runs before dotenv/configuration loading. No journal means no speculative repair. */
export async function recoverRuntimeSetupEdit(rootDir: string): Promise<void> {
  try {
    requireRuntimeSetupEditSettled(rootDir);
    return;
  } catch {
    // Parsing and lock acquisition below decide whether recovery is safe.
  }
  const root = await realpath(rootDir);
  await withFileLock(
    join(root, ".runtime-setup.lock"),
    async () => {
      const journal = await readSetupEditJournal(root);
      if (!journal) return;
      await withSetupEditRecoveryLocks(journal, async () => {
        const current = await readSetupEditJournal(root);
        if (!current || JSON.stringify(current) !== JSON.stringify(journal))
          throw setupEditRecoveryRequired();
        await reconcileSetupEditJournal(journal);
      });
    },
    CONFIG_FILE_LOCK_OPTIONS,
  );
}
