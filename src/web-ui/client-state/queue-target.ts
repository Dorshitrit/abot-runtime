import type { SessionStore } from "../../runtime/ports.js";
import { ClientStateError } from "./contracts.js";

type QueueSessions = Pick<SessionStore, "getRequestReplayById">;
export type ClientQueueTargetValidator = (input: Record<string, unknown>) => Promise<void>;

/** Check after acquiring client state, so a completed reset cannot revive an old queue. */
export async function validateRuntimeQueueTarget(
  input: Record<string, unknown>, getSessions: (environmentId: string) => QueueSessions,
): Promise<void> {
  if (input.kind !== "queue" || input.action !== "enqueue") return;
  const scope = input.scope as { environmentId?: unknown; sessionId?: unknown } | undefined;
  const item = input.item as { waitForRequestId?: unknown } | undefined;
  // The queue decoder remains responsible for malformed scopes and items.
  if (typeof scope?.environmentId !== "string" || !scope.environmentId.trim()) return;
  if (typeof scope.sessionId !== "string" || !scope.sessionId.trim()) return;
  if (typeof item?.waitForRequestId !== "string" || !item.waitForRequestId) return;
  const replay = await getSessions(scope.environmentId).getRequestReplayById(
    item.waitForRequestId, 0, scope.sessionId,
  );
  // The replay hint is not authority: its legacy fallback may find another session.
  if (replay?.sessionId === scope.sessionId && replay.requestId === item.waitForRequestId) return;
  throw new ClientStateError("queue_target_unavailable",
    "This conversation or request is no longer available. Your message was not queued.", 409);
}
