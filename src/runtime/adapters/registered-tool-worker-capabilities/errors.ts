export class RegisteredToolWorkerCapabilityCompositionError extends TypeError {
  readonly issueCode: string;
  readonly operationId?: string;

  constructor(issueCode: string, operationId?: string) {
    super(
      [
        "registered_tool_worker_capability_provider",
        issueCode,
        ...(operationId ? [operationId] : []),
      ].join(":"),
    );
    this.name = "RegisteredToolWorkerCapabilityCompositionError";
    this.issueCode = issueCode;
    this.operationId = operationId;
  }
}

export class RegisteredToolWorkerCapabilityExecutionError extends TypeError {
  readonly issueCode: string;

  constructor(issueCode: string) {
    super(`registered_tool_worker_capability_execution:${issueCode}`);
    this.name = "RegisteredToolWorkerCapabilityExecutionError";
    this.issueCode = issueCode;
  }
}

export function executionProtocolError(
  issueCode: string,
): RegisteredToolWorkerCapabilityExecutionError {
  return new RegisteredToolWorkerCapabilityExecutionError(issueCode);
}

export function normalizeResolutionError(error: unknown): Error {
  return error instanceof RegisteredToolWorkerCapabilityCompositionError
    ? error
    : new RegisteredToolWorkerCapabilityCompositionError("resolution_failed");
}
