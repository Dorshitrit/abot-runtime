import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAgentState } from "./state-validation.js";

/** Client presentation uses the Agent-owned index; ordinary session execution is unchanged. */
export async function readAgentAssociations(runtimeDir: string): Promise<Readonly<{sessionIds: ReadonlySet<string>; requestIds: ReadonlySet<string>}>> {
  let bytes: string;
  try { bytes = await readFile(join(runtimeDir, "agents", "state.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessionIds: new Set(), requestIds: new Set() };
    throw error;
  }
  const state = readAgentState(JSON.parse(bytes));
  return { sessionIds: new Set(state.sessions.map((entry) => entry.sessionId)), requestIds: new Set(state.attempts.map((entry) => entry.request.requestId)) };
}

export async function readAgentSessionIds(runtimeDir: string): Promise<ReadonlySet<string>> {
  return (await readAgentAssociations(runtimeDir)).sessionIds;
}

export async function assertOrdinaryWebSession(runtimeDir: string, sessionId: string): Promise<void> {
  const owned = await readAgentSessionIds(runtimeDir);
  if (owned.has(sessionId) || owned.has(sessionId.trim())) throw new Error("agent_session_requires_agents_workspace");
}

export async function assertCanResetAgentSessions(runtimeDir: string): Promise<void> {
  const ids = await readAgentSessionIds(runtimeDir).catch(() => { throw new Error("agent_session_index_unavailable"); });
  if (ids.size) throw new Error("agents_sessions_prevent_bulk_reset");
}
