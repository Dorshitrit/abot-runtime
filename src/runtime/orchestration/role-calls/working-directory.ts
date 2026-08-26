export const ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH = 4_096;
export const ROLE_CALL_PORTABLE_WORKING_DIRECTORY_PATTERN =
  "^(?:\\.|[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)$";

const PORTABLE_DIRECTORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

export type RoleCallWorkingDirectoryRoleId = "planner" | "worker";

/** Only coordination and execution calls may own a canonical path base. */
export function isRoleCallWorkingDirectoryRoleId(
  input: unknown,
): input is RoleCallWorkingDirectoryRoleId {
  return input === "planner" || input === "worker";
}

/**
 * Normalizes an agent-work-directory-relative role-call working directory.
 * The canonical root is represented by `.` and traversal is never accepted.
 */
export function normalizeRoleCallWorkingDirectory(
  input: unknown,
): string | undefined {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH
  ) {
    return undefined;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return undefined;

  const slashNormalized = trimmed.replace(/\\/g, "/");
  const withoutLeadingCurrentDirectory = slashNormalized.replace(
    /^(?:\.\/)+/,
    "",
  );
  if (
    withoutLeadingCurrentDirectory.startsWith("/") ||
    /^[A-Za-z]:/.test(withoutLeadingCurrentDirectory)
  ) {
    return undefined;
  }

  const rawSegments = slashNormalized.split("/");
  if (rawSegments.some((segment) => segment === "..")) return undefined;

  const segments = rawSegments.filter(
    (segment) => segment.length > 0 && segment !== ".",
  );
  const normalized = segments.length === 0 ? "." : segments.join("/");
  return normalized.length <= ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH
    ? normalized
    : undefined;
}

/**
 * Strict portable form used when an active capability principal establishes
 * its own immutable execution base. Existing delegated-call normalization is
 * intentionally unchanged for compatibility.
 */
export function normalizeEstablishedRoleCallWorkingDirectory(
  input: unknown,
): string | undefined {
  const normalized = normalizeRoleCallWorkingDirectory(input);
  if (!normalized) return undefined;
  return normalized === "." ||
    normalized
      .split("/")
      .every((segment) => PORTABLE_DIRECTORY_SEGMENT.test(segment))
    ? normalized
    : undefined;
}
