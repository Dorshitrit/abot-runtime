import type { ServerResponse } from "node:http";
import { assertOrdinaryWebSession } from "../../runtime/agents/session-association.js";
import { sendJson } from "./http.js";

/** The Chat surface cannot target work owned by the separate Agent workspace. */
export async function acceptOrdinaryChatSession(runtimeDir: string, sessionId: unknown, response: ServerResponse): Promise<boolean> {
  if (typeof sessionId !== "string" || !sessionId) return true;
  try { await assertOrdinaryWebSession(runtimeDir, sessionId); return true; }
  catch (error) {
    const owned = error instanceof Error && error.message === "agent_session_requires_agents_workspace";
    sendJson(response, owned ? 409 : 503, { ok: false,
      error: owned ? "agent_session_requires_agents_workspace" : "agent_session_index_unavailable" });
    return false;
  }
}
