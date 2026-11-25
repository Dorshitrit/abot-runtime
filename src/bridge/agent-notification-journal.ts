import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentNotificationCursor, AgentNotificationEntry } from "../runtime/agents/notification-attention.js";
import { emptyAgentNotificationCursor } from "../runtime/agents/notification-attention.js";
import { ensurePrivateRuntimeDirectory } from "../runtime/local-host/private-directory.js";
import { assertPrivateRuntimeAccess } from "../runtime/local-host/private-access.js";
import { syncAgentStateDirectoryPath } from "../runtime/agents/durable-state-file.js";
import { replacePreparedSessionFile } from "../sessions/prepared-session-replacement.js";

export type AgentNotificationJournal = Readonly<{
  version: 1; activatedAt: number; cursor: AgentNotificationCursor;
  pending?: Readonly<{ cursor: AgentNotificationCursor; entries: readonly AgentNotificationEntry[] }>;
}>;
export type AgentNotificationJournalStore = Readonly<{
  read(): Promise<AgentNotificationJournal>;
  write(value: AgentNotificationJournal): Promise<void>;
}>;
function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function validCursor(value: unknown): value is AgentNotificationCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as AgentNotificationCursor;
  if (!Array.isArray(cursor.attention) || !Array.isArray(cursor.waits)) return false;
  for (const ids of [cursor.approvals, cursor.delivered]) {
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)))) return false;
  }
  if (!cursor.attention.every(entry => typeof entry?.agentId === "string" && nonNegativeInteger(entry.messages) && nonNegativeInteger(entry.traces))) return false;
  return cursor.waits.every(entry => typeof entry?.missionId === "string" && nonNegativeInteger(entry.revision));
}
function validEntry(value: unknown): value is AgentNotificationEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as AgentNotificationEntry;
  if (!/^[a-f0-9]{64}$/.test(entry.eventId) || typeof entry.targetAgentId !== "string" || typeof entry.missionId !== "string") return false;
  if (entry.messageId !== undefined && typeof entry.messageId !== "string") return false;
  if (!["reply", "question", "completed", "result", "exhausted", "plan", "attention"].includes(entry.reason)) return false;
  return nonNegativeInteger(entry.createdAt) && nonNegativeInteger(entry.expiresAt) && typeof entry.output === "string" && [...entry.output].length <= 600;
}
function readJournal(value: unknown): AgentNotificationJournal {
  const state = value as AgentNotificationJournal | null;
  if (!state || state.version !== 1 || !nonNegativeInteger(state.activatedAt) || !validCursor(state.cursor)) throw new Error("agents_notification_journal_invalid");
  if (state.pending && (!validCursor(state.pending.cursor) || !Array.isArray(state.pending.entries) || state.pending.entries.length > 50 || !state.pending.entries.every(validEntry)))
    throw new Error("agents_notification_journal_invalid");
  return state;
}

/** One journal per exact Socket grant; it contains public pending previews, never credentials. */
export function createAgentNotificationJournal(runtimeDirectory: string, target: readonly string[], now = Date.now): AgentNotificationJournalStore {
  const directory = join(runtimeDirectory, "agents", "notification-delivery");
  const key = createHash("sha256").update(JSON.stringify(target)).digest("hex");
  const filename = join(directory, key + ".json");
  async function write(value: AgentNotificationJournal): Promise<void> {
    readJournal(value);
    await ensurePrivateRuntimeDirectory(directory);
    const temporary = join(directory, randomUUID() + ".tmp");
    const file = await open(temporary, "wx", 0o600);
    try {
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { await file.close(); }
      await replacePreparedSessionFile(temporary, filename);
      await syncAgentStateDirectoryPath(directory);
    } finally { await rm(temporary, { force: true }); }
  }
  return { write, async read() {
    await ensurePrivateRuntimeDirectory(directory);
    try {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("agents_notification_journal_invalid");
      await assertPrivateRuntimeAccess(filename, stat, "agents_notification_journal_not_private");
      return readJournal(JSON.parse(await readFile(filename, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const initial: AgentNotificationJournal = { version: 1, activatedAt: now(), cursor: emptyAgentNotificationCursor() };
      await write(initial);
      return initial;
    }
  } };
}
