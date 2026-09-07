import { isAbsolute } from "node:path";

import { DirectoryAuthorityError } from "./errors.js";

export const AUTHORITY_MESSAGE_LIMIT = 8 * 1024 * 1024;
export const AUTHORITY_STDERR_LIMIT = 16 * 1024;
export const AUTHORITY_TASK_TIMEOUT_MS = 30_000;

export type DirectoryAuthorityLocation = Readonly<{
  directoryPath: string;
  directoryFd: number;
}>;

export function assertDirectoryAuthorityLocation(
  location: DirectoryAuthorityLocation,
): void {
  if (!isAbsolute(location.directoryPath)) {
    throw new DirectoryAuthorityError(
      "directory_authority_invalid_path",
      "The directory authority requires an absolute starting path.",
    );
  }
  const hasOpenDescriptorNumber =
    Number.isInteger(location.directoryFd) && location.directoryFd >= 0;
  if (hasOpenDescriptorNumber) return;
  throw new DirectoryAuthorityError(
    "directory_authority_invalid_fd",
    "The directory authority requires an open directory descriptor.",
  );
}

export function authorityEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.NODE_OPTIONS;
  delete sanitized.NODE_PATH;
  return sanitized;
}

export function encodeAuthorityRequest(input: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new DirectoryAuthorityError(
      "directory_authority_invalid_request",
      "The directory operation input must be JSON serializable.",
    );
  }
  if (encoded === undefined) {
    throw new DirectoryAuthorityError(
      "directory_authority_invalid_request",
      "The directory operation input must be JSON serializable.",
    );
  }
  if (Buffer.byteLength(encoded) <= AUTHORITY_MESSAGE_LIMIT) return encoded;
  throw new DirectoryAuthorityError(
    "directory_authority_request_too_large",
    "The directory operation input exceeds the bridge byte limit.",
  );
}

function isAuthorityMessageObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeAuthorityResult<Result>(output: string): Result {
  let message: unknown;
  try {
    message = JSON.parse(output);
  } catch {
    throw new DirectoryAuthorityError(
      "directory_authority_protocol_error",
      "The directory operation returned an invalid response.",
    );
  }
  if (!isAuthorityMessageObject(message)) {
    throw new DirectoryAuthorityError(
      "directory_authority_protocol_error",
      "The directory operation returned an invalid response.",
    );
  }
  if (message.ok === true) return message.result as Result;
  const hasAuthorityError =
    message.ok === false && isAuthorityMessageObject(message.error);
  if (!hasAuthorityError) {
    throw new DirectoryAuthorityError(
      "directory_authority_protocol_error",
      "The directory operation returned an invalid response.",
    );
  }
  const {
    code,
    message: explanation,
    data,
  } = message.error as Record<string, unknown>;
  const hasErrorDescription =
    typeof code === "string" && typeof explanation === "string";
  if (!hasErrorDescription) {
    throw new DirectoryAuthorityError(
      "directory_authority_protocol_error",
      "The directory operation returned an invalid error response.",
    );
  }
  throw new DirectoryAuthorityError(
    code,
    explanation,
    isAuthorityMessageObject(data) ? data : undefined,
  );
}
