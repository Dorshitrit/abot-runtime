import type { RealtimeClientHub } from "./realtime-hub.js";

export type WorkspaceChangeNotifier = (
  environmentId: string,
  resources: readonly ("sessions" | "approvals")[],
) => void;

/** Invalidate client projections only; a disconnected observer cannot undo a commit. */
export function createWorkspaceChangeNotifier(
  realtime: Pick<RealtimeClientHub, "broadcast">,
): WorkspaceChangeNotifier {
  return (environmentId, resources) => {
    try {
      realtime.broadcast({
        type: "workspace_changed",
        environment: environmentId,
        resources: [...resources],
      });
    } catch {
      // Reconnecting clients fetch the canonical state again.
    }
  };
}
