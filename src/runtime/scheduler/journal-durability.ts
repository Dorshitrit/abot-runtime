import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** The replacement is visible, but its directory entry is not confirmed durable. */
export class JournalPublicationSyncError extends Error {
  constructor(cause: unknown) {
    super("scheduler_store_directory_sync_failed", { cause });
  }
}

function supportsJournalDirectorySync(): boolean {
  // Node does not support opening Windows directories for FileHandle.sync().
  return process.platform !== "win32";
}

export async function syncJournalDirectory(directory: string): Promise<void> {
  if (!supportsJournalDirectorySync()) return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Establish the owned root, including directories left by an interrupted mkdir. */
export async function syncJournalDirectoryPath(
  directory: string,
): Promise<void> {
  if (!supportsJournalDirectorySync()) return;
  let current = resolve(directory);
  for (;;) {
    await syncJournalDirectory(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function writeJournalJson(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await syncJournalDirectory(dirname(path));
  } catch (error) {
    // Do not unlink or roll back a replacement that readers can already see.
    throw new JournalPublicationSyncError(error);
  }
}
