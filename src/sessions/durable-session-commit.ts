import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecord } from "./types.js";

export class SessionCommitOutcomeUnknownError extends Error {
  readonly code = "session_commit_outcome_unknown";
  constructor(
    readonly sessionId: string,
    options: ErrorOptions,
  ) {
    super(
      "Session replacement completed but its durable commit could not be confirmed.",
      options,
    );
    this.name = "SessionCommitOutcomeUnknownError";
  }
}

export async function syncSessionDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node. File data is synced
  // before its atomic replacement; power-loss guarantees remain platform-specific.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Same session file and replacement boundary, with explicit durable-commit errors. */
export async function saveDurableSessionFile(
  sessionsDir: string,
  session: SessionRecord,
  assertCurrent?: () => void,
): Promise<void> {
  const target = join(sessionsDir, `${session.id}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let replaced = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(session, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertCurrent?.();
    await rename(temporary, target);
    replaced = true;
    await syncSessionDirectory(sessionsDir);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (replaced)
      throw new SessionCommitOutcomeUnknownError(session.id, { cause: error });
    throw error;
  }
}
