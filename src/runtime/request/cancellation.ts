/** User cancellation is a terminal control signal, never a model instruction. */
export const REQUEST_CANCELLED = "request_cancelled";

export type SavedWaitCancellation = Readonly<{
  generation: string;
  waitId: string;
  revision: number;
  commandId: string;
}>;

export type RequestCancellationResult = Readonly<{
  accepted: boolean;
  reason?:
    | "request_not_active"
    | "session_mismatch"
    | "cancellation_unavailable";
}>;

export function createRequestCancellationError(): Error {
  return new Error(REQUEST_CANCELLED);
}

export function isRequestCancelled(signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    signal.reason instanceof Error &&
    signal.reason.message === REQUEST_CANCELLED
  );
}

export function throwIfRequestCancelled(signal: AbortSignal): void {
  if (isRequestCancelled(signal)) throw signal.reason;
}
