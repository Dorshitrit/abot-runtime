import type { LongTermMemoryManagementErrorCode } from "./contracts.js";

export class LongTermMemoryManagementError extends Error {
  readonly code: LongTermMemoryManagementErrorCode;
  readonly memoryId?: string;

  constructor(
    code: LongTermMemoryManagementErrorCode,
    options: Readonly<{ cause?: unknown; memoryId?: string }> = {},
  ) {
    super(
      code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "LongTermMemoryManagementError";
    this.code = code;
    this.memoryId = options.memoryId;
  }
}

export function isLongTermMemoryManagementError(
  error: unknown,
): error is LongTermMemoryManagementError {
  return error instanceof LongTermMemoryManagementError;
}
