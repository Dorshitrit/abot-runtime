/** Owner loss ends active execution without inventing a user decision. */
export const REQUEST_INTERRUPTED = "request_interrupted";

export function createRequestInterruptionError(): Error {
  return new Error(REQUEST_INTERRUPTED);
}

export function isRequestInterruption(error: unknown): error is Error {
  return error instanceof Error && error.message === REQUEST_INTERRUPTED;
}

export function isRequestInterrupted(signal: AbortSignal): boolean {
  return signal.aborted && isRequestInterruption(signal.reason);
}
