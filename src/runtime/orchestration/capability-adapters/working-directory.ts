import {
  normalizeEstablishedRoleCallWorkingDirectory,
  ROLE_CALL_PORTABLE_WORKING_DIRECTORY_PATTERN,
  ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
} from "../role-calls/index.js";

export const EXECUTION_WORKING_DIRECTORY_MAX_LENGTH =
  ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH;
export const EXECUTION_WORKING_DIRECTORY_PATTERN =
  ROLE_CALL_PORTABLE_WORKING_DIRECTORY_PATTERN;

/** Normalizes one portable agent-work-directory-relative execution base. */
export function normalizeExecutionWorkingDirectory(
  input: unknown,
): string | undefined {
  return normalizeEstablishedRoleCallWorkingDirectory(input);
}
