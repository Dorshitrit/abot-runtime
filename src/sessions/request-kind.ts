import type { SessionRequestRecord } from "./types.js";

/** Commands create their stream with a tagged first event, including terminal-only recovery. */
export function isCommandSessionRequest(request: Pick<SessionRequestRecord, "events">): boolean {
  return request.events[0]?.payload.requestKind === "command";
}
