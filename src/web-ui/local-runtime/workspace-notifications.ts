import type { RuntimeSessionsResetResult } from "../../runtime/local-host/maintenance-contracts.js";
import type { RealtimeClientHub } from "./realtime-hub.js";

export type RuntimeSessionResetNotice = RuntimeSessionsResetResult & Readonly<{ resetId: string }>;

export type WorkspaceChangeNotifier = (
  environmentId: string,
  resources: readonly ("sessions" | "approvals" | "information-basket" | "client-state")[],
  sessionReset?: RuntimeSessionResetNotice,
) => void;

/** Invalidate client projections only; a disconnected observer cannot undo a commit. */
export function createWorkspaceChangeNotifier(
  realtime: Pick<RealtimeClientHub, "broadcast">,
): WorkspaceChangeNotifier {
  return (environmentId, resources, sessionReset) => {
    try {
      realtime.broadcast({
        type: "workspace_changed",
        environment: environmentId,
        resources: [...resources],
        ...(sessionReset ? { sessionReset } : {}),
      });
    } catch {
      // Reconnecting clients fetch the canonical state again.
    }
  };
}
