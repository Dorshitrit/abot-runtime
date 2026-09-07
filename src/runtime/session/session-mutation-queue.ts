export type SessionMutationQueue = <T>(
  sessionId: string,
  operation: () => Promise<T>,
) => Promise<T>;

/** One queue per store lifetime; unrelated sessions remain independent. */
export function createSessionMutationQueue(): SessionMutationQueue {
  const queues = new Map<string, Promise<void>>();
  return (sessionId, operation) => {
    const predecessor = queues.get(sessionId) ?? Promise.resolve();
    const result = predecessor.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(sessionId, settled);
    void settled.then(() => {
      if (queues.get(sessionId) === settled) queues.delete(sessionId);
    });
    return result;
  };
}
