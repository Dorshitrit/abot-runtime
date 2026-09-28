import { projectLearningChangedEvent } from "../../runtime/local-host/learning-events.js";
import type { RealtimeClientHub } from "./realtime-hub.js";
import { createWorkspaceChangeNotifier } from "./workspace-notifications.js";

export function createLearningChangeNotifier(
  realtime: Pick<RealtimeClientHub, "broadcast">,
) {
  const notifyWorkspace = createWorkspaceChangeNotifier(realtime);
  return (environmentId: string, change?: unknown): void => {
    const event = projectLearningChangedEvent(change);
    try {
      realtime.broadcast({
        type: "learning.changed",
        environmentId,
        ...(event ? { event } : {}),
      });
    } catch {
      // Persisted conversations and proposal status are fetched on reconnect.
    }
    if (event) notifyWorkspace(environmentId, ["sessions"]);
  };
}
