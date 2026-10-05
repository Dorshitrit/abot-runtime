import {
  createRequestSteeringInbox,
  type RequestSteeringInbox,
} from "./request-steering.js";

/** Internal automation nodes cannot accept user steering at any transport. */
export function createLockedRequestSteeringInbox(
  requestId: string,
): RequestSteeringInbox {
  const inbox = createRequestSteeringInbox({ requestId });
  return Object.freeze({
    ...inbox,
    append: () =>
      Object.freeze({
        ok: false as const,
        reason: "automation_session_locked" as const,
      }),
  });
}
