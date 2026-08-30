const WORKER_CAPABILITY_REJECTION_PREFIX = "worker_capability_rejected:";

export function workerCapabilityBindingRejection(issueCode: string): Error {
  return new Error(`${WORKER_CAPABILITY_REJECTION_PREFIX}${issueCode}`);
}

export function isWorkerCapabilityBindingRejection(
  error: unknown,
): error is Error {
  return (
    error instanceof Error &&
    error.message.startsWith(WORKER_CAPABILITY_REJECTION_PREFIX)
  );
}
