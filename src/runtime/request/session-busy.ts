export const SESSION_BUSY = "session_busy";

/** A rejected submission has not entered the request runner or session history. */
export function createSessionBusyError(): Error {
  return Object.assign(new Error(SESSION_BUSY), { code: SESSION_BUSY });
}

/** The active request and its saved ASK wait both exclude a new submission. */
export function getSessionAdmissionErrorCode(
  error: unknown,
): "session_busy" | "session_awaiting_approval" | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message === SESSION_BUSY) return SESSION_BUSY;
  if (error.message === "session_awaiting_approval") return error.message;
  return undefined;
}
