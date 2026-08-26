import {
  failureFromError,
  failureResult,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";

export class ExecPluginError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExecPluginError";
    this.code = code;
  }
}

export function execFailureFromError(
  error: unknown,
  operation: "exec" | "exec_wait" | "exec_cancel",
): ToolImplementationOutput {
  if (error instanceof ExecPluginError) {
    return failureResult({
      errorCode: error.code,
      message: error.message,
      output: `${operation} failed: ${error.message}`,
    });
  }
  return failureFromError(error, {
    fallbackCode: `${operation}_failed`,
    fallbackMessage: `${operation} failed without a safe diagnostic.`,
    operation,
  });
}
