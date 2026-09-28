const STARTUP_FAILURE_CODES = new Set([
  "host_broker_requires_linux_runtime",
  "local_runtime_directory_not_private",
  "host_state_directory_invalid",
  "host_state_owner_invalid",
  "host_state_directory_not_private",
  "host_broker_socket_invalid",
  "host_broker_socket_owner_invalid",
  "long_term_memory_store_lock_timeout",
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EBADF",
  "EEXIST",
  "EINVAL",
  "EISDIR",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
]);
const UNKNOWN_STARTUP_FAILURE = "host_broker_startup_failed";

function isRecognizedStartupFailureCode(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return STARTUP_FAILURE_CODES.has(value);
}

function startupFailureCode(error: unknown): string {
  if (typeof error !== "object") return UNKNOWN_STARTUP_FAILURE;
  if (error === null) return UNKNOWN_STARTUP_FAILURE;
  const code = (error as { code?: unknown }).code;
  if (isRecognizedStartupFailureCode(code)) return code;
  if (!(error instanceof Error)) return UNKNOWN_STARTUP_FAILURE;
  if (isRecognizedStartupFailureCode(error.message)) return error.message;
  return UNKNOWN_STARTUP_FAILURE;
}

/** Only fixed codes leave this boundary; native errors can contain private paths. */
export function reportHostStartupFailure(error: unknown): void {
  console.error({
    event: "host_broker_startup_failed",
    code: startupFailureCode(error),
  });
}
