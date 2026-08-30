export const WORKER_CAPABILITY_OPERATION_SUPERVISION_LIMIT_ERROR =
  "worker_capability_begin_rejected:operation_supervision_limit_exceeded" as const;

export class WorkerCapabilityOperationSupervisionLimitError extends Error {
  readonly issueCode = "operation_supervision_limit_exceeded" as const;

  constructor() {
    super(WORKER_CAPABILITY_OPERATION_SUPERVISION_LIMIT_ERROR);
    this.name = "WorkerCapabilityOperationSupervisionLimitError";
  }
}

export function isWorkerCapabilityOperationSupervisionLimitError(
  error: unknown,
): error is WorkerCapabilityOperationSupervisionLimitError {
  return error instanceof WorkerCapabilityOperationSupervisionLimitError;
}
