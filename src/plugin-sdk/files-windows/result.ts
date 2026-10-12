import type { BoundedRegularFileReadResult } from "../files.js";

export function windowsReadError(code: string): Error {
  const error = new Error(
    "The Windows safe file read failed (" + code + "). No fallback read was attempted.",
  );
  return Object.assign(error, { code });
}

export function windowsReadAbortError(): Error {
  const error = new Error("The file read was cancelled.");
  error.name = "AbortError";
  return error;
}

const FAILURE_REASONS = new Set([
  "not_regular_file",
  "too_large",
  "changed_during_read",
  "outside_root",
  "safe_open_unsupported",
]);

function hasByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeNativeFailure(code: string): BoundedRegularFileReadResult {
  switch (code) {
    case "filesystem_windows_policy_blocked":
    case "filesystem_windows_helper_unavailable":
    case "filesystem_safe_io_unsupported":
      return Object.freeze({ ok: false, reason: "safe_open_unsupported" });
    case "filesystem_path_changed":
    case "filesystem_target_changed":
    case "filesystem_read_changed":
    case "filesystem_read_incomplete":
      return Object.freeze({ ok: false, reason: "changed_during_read" });
    case "file_too_large":
      return Object.freeze({ ok: false, reason: "too_large" });
    case "file_not_found": throw windowsReadError("ENOENT");
    case "filesystem_access_denied": throw windowsReadError("EACCES");
    default: throw windowsReadError("EIO");
  }
}

export function decodeWindowsReadResult(
  raw: string,
  maxBytes: number,
): BoundedRegularFileReadResult {
  let value;
  try { value = JSON.parse(raw); }
  catch { throw windowsReadError("EIO"); }
  if (value?.ok === false && typeof value.code === "string")
    return decodeNativeFailure(value.code);
  if (value?.ok === false && FAILURE_REASONS.has(value.reason)) {
    if (value.byteCount !== undefined && !hasByteCount(value.byteCount))
      throw windowsReadError("EIO");
    return Object.freeze({
      ok: false,
      reason: value.reason,
      ...(value.byteCount !== undefined ? { byteCount: value.byteCount } : {}),
    });
  }
  if (value?.ok !== true || !hasByteCount(value.byteCount))
    throw windowsReadError("EIO");
  if (value.byteCount > maxBytes || typeof value.bytes !== "string")
    throw windowsReadError("EIO");
  if (value.bytes.length !== 4 * Math.ceil(value.byteCount / 3))
    throw windowsReadError("EIO");
  const bytes = Buffer.from(value.bytes, "base64");
  if (bytes.length !== value.byteCount || bytes.toString("base64") !== value.bytes)
    throw windowsReadError("EIO");
  return Object.freeze({ ok: true, bytes, byteCount: value.byteCount });
}
