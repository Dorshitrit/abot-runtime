import {
  withConfigFileTransaction,
  type ConfigFileTransaction,
} from "../runtime/adapters/config-file-transaction.js";

function requireRuntimeTransaction(
  transaction: ConfigFileTransaction,
  runtimePath: string,
): void {
  if (transaction.path !== runtimePath)
    throw new Error("Runtime configuration transaction target does not match.");
}

/** Resolve linked targets only while holding their canonical Runtime lock. */
export async function withConfigDashboardRootTransaction<T>(
  runtimePath: string,
  transaction: ConfigFileTransaction | undefined,
  operation: (root: ConfigFileTransaction) => Promise<T>,
): Promise<T> {
  if (!transaction) return withConfigFileTransaction(runtimePath, operation);
  // Never acquire a root lock while a caller is holding a child-only lock.
  requireRuntimeTransaction(transaction, runtimePath);
  return operation(transaction);
}

/** The Runtime lock is always first; aliases of that same file reuse it. */
export async function withConfigDashboardTargetTransaction<T>(
  root: ConfigFileTransaction,
  targetPath: string,
  operation: (target: ConfigFileTransaction) => Promise<T>,
): Promise<T> {
  if (targetPath === root.path) return operation(root);
  return withConfigFileTransaction(targetPath, operation, {
    allowMalformedJson: true,
  });
}
