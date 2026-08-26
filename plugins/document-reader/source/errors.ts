import {
  failureFromError,
  failureResult,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";

type NodeError = Error & Readonly<{ code?: unknown }>;

export class DocumentReaderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DocumentReaderError";
    this.code = code;
  }
}

export function failDocument(code: string, message: string): never {
  throw new DocumentReaderError(code, message);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    typeof (error as NodeError).code === "string" &&
    (error as NodeError).code === code
  );
}

export function rethrowDocumentIoError(error: unknown): never {
  if (error instanceof DocumentReaderError) throw error;
  if (hasNodeErrorCode(error, "ENOENT")) {
    failDocument(
      "document_not_found",
      "The requested document does not exist.",
    );
  }
  if (hasNodeErrorCode(error, "EACCES") || hasNodeErrorCode(error, "EPERM")) {
    failDocument(
      "document_access_denied",
      "Access to the requested document was denied.",
    );
  }
  if (hasNodeErrorCode(error, "EISDIR")) {
    failDocument(
      "document_target_not_file",
      "The requested document is not a regular file.",
    );
  }
  if (
    hasNodeErrorCode(error, "ABORT_ERR") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    failDocument("document_read_cancelled", "Document reading was cancelled.");
  }
  throw error;
}

export function documentReaderFailure(
  error: unknown,
): ToolImplementationOutput {
  if (error instanceof DocumentReaderError) {
    return failureResult({
      errorCode: error.code,
      message: error.message,
      output: `read_document failed: ${error.message}`,
    });
  }
  return failureFromError(error, {
    fallbackCode: "document_read_failed",
    fallbackMessage: "Document reading failed.",
    operation: "read_document",
  });
}
