/** Bound asynchronous validation to the same deadline as its provider attempt.
 * The callback must also pass this signal to its own asynchronous work.
 */
export function acceptModelStepOutput<T>(
  accept: () => T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return accept();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) reject(signal.reason);
          else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(signal.aborted ? signal.reason : error);
        },
      );
  });
}

/** The same deadline boundary also applies while awaiting shared model preparation. */
export { acceptModelStepOutput as awaitModelStepWork };
