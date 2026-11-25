import type { SessionRequestLifecycleSnapshot } from "../../sessions/request-lifecycle/contracts.js";
import type { SessionStore } from "../ports.js";
import type { AgentState } from "./agent-records.js";

/** Read the existing ordinary-session wait identity, never its continuation or tool payload. */
export async function readAgentNotificationApprovals(state: AgentState, sessions: Pick<SessionStore, "requestLifecycle">): Promise<readonly SessionRequestLifecycleSnapshot[]> {
  const lifecycle = sessions.requestLifecycle;
  if (!lifecycle) return [];
  const snapshots: SessionRequestLifecycleSnapshot[] = [];
  for (const attempt of state.attempts) {
    if (attempt.status !== "awaiting_approval" || attempt.userResolved) continue;
    const mission = state.missions.find(value => value.id === attempt.missionId && value.agentId === attempt.agentId);
    if (mission?.status !== "active") continue;
    const snapshot = await lifecycle.get(attempt.request.sessionId, attempt.request.requestId);
    if (snapshot?.sessionId !== attempt.request.sessionId || snapshot.requestId !== attempt.request.requestId) continue;
    if (snapshot.status !== "awaiting_approval" || !snapshot.wait) continue;
    snapshots.push(snapshot);
  }
  return snapshots;
}
