const pendingTransactions = new Map<string, Promise<unknown>>();

/** Order this process's callers before they contend for the cross-process file lock. */
export async function serializeClientStateTransaction<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pendingTransactions.get(path) ?? Promise.resolve();
  // Report each failure to its own caller without blocking later transactions.
  const pending = previous.catch(() => undefined).then(operation);
  pendingTransactions.set(path, pending);
  try {
    return await pending;
  } finally {
    if (isCurrentTransactionTail(path, pending)) pendingTransactions.delete(path);
  }
}

function isCurrentTransactionTail(path: string, pending: Promise<unknown>): boolean {
  return pendingTransactions.get(path) === pending;
}
