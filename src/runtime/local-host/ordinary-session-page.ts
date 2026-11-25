import { listSessionMetadata } from "../../sessions/metadata/store.js";
import { normalizeCursor, normalizeLimit, toSessionListItem } from "../../sessions/record/projection.js";
import type { SessionListResult } from "../../sessions/types.js";
import { readAgentSessionIds } from "../agents/session-association.js";
import type { RuntimeConfig, SessionStore } from "../ports.js";

/** Snapshot candidates before ownership; a work session is always bound before its file is created. */
export async function listOrdinarySessionPage(paths: Pick<RuntimeConfig["paths"], "runtimeDir" | "sessionsDir">, args: readonly unknown[],
  customStore?: Pick<SessionStore, "getAllSessions">): Promise<SessionListResult> {
  const input = args[0] ?? {};
  if (args.length > 1 || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_session_list_query");
  const { cursor, limit } = input as { cursor?: string; limit?: number };
  const candidates = customStore
    ? (await customStore.getAllSessions()).map(toSessionListItem)
    : (await listSessionMetadata(paths.sessionsDir)).filter(record => record.interactive).map(record => record.summary);
  const owned = await readAgentSessionIds(paths.runtimeDir).catch(() => { throw new Error("agent_session_index_unavailable"); });
  const visible = candidates.filter(summary => !owned.has(summary.id));
  const start = normalizeCursor(cursor);
  const summaries = visible.slice(start, start + normalizeLimit(limit));
  const end = start + summaries.length;
  return { sessions: summaries, nextCursor: end < visible.length ? String(end) : null };
}
