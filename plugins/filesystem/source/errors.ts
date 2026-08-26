import { isRuntimeToolPathError } from "../../../src/plugin-sdk/index.js";

type NodeError = Error & Readonly<{ code?: unknown }>;

export class FilesystemToolError extends Error {
  readonly code: string;
  readonly data?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string = code,
    data?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "FilesystemToolError";
    this.code = code;
    this.data = data;
  }
}

export function fail(
  code: string,
  message: string = code,
  data?: Readonly<Record<string, unknown>>,
): never {
  throw new FilesystemToolError(code, message, data);
}

export function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    typeof (error as NodeError).code === "string" &&
    (error as NodeError).code === code
  );
}

export function rethrowFilesystemError(
  error: unknown,
  operation: "inspect" | "read" | "write",
  logicalPath: string,
): never {
  if (isRuntimeToolPathError(error) || error instanceof FilesystemToolError) {
    throw error;
  }
  if (isNodeErrorCode(error, "ENOENT")) {
    fail("file_not_found", `Path does not exist: ${logicalPath}`);
  }
  if (isNodeErrorCode(error, "EACCES") || isNodeErrorCode(error, "EPERM")) {
    fail(
      "filesystem_access_denied",
      `Access was denied while attempting to ${operation}: ${logicalPath}`,
    );
  }
  if (isNodeErrorCode(error, "EISDIR")) {
    fail("not_a_file", `Expected a regular file: ${logicalPath}`);
  }
  fail(
    `filesystem_${operation}_failed`,
    `Filesystem ${operation} failed for ${logicalPath}.`,
  );
}
