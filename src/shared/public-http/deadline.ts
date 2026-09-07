import { PublicHttpError } from "./errors.js";

export function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new PublicHttpError(
      "web_request_timed_out",
      "The upstream web request timed out.",
    );
  }
  return remaining;
}

export function withinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  if (abortSignal?.aborted) {
    return Promise.reject(
      new PublicHttpError(
        "web_request_aborted",
        "The web request was aborted.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          new PublicHttpError(
            "web_request_aborted",
            "The web request was aborted.",
          ),
        ),
      );
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(
            new PublicHttpError(
              "web_request_timed_out",
              "The upstream web request timed out.",
            ),
          ),
        ),
      remainingTime(deadline),
    );
    timeout.unref?.();
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
