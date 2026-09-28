/** Serializes observation and injection within the caller's desktop exclusion scope. */
const desktopTails = new Map<string, Promise<void>>();

export async function withDesktopQueue<T>(
  identity: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const previous = desktopTails.get(identity) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => done);
  desktopTails.set(identity, tail);
  try {
    await waitForDesktopTurn(previous, signal);
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
    void tail.then(() => {
      if (desktopTails.get(identity) === tail) desktopTails.delete(identity);
    });
  }
}

function waitForDesktopTurn(
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return previous;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void previous.then(() => {
      cleanup();
      resolve();
    });
  });
}
