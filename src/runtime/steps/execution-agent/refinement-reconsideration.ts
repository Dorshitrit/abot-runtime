import type { StructuredModelInvalidOutputError } from "../../model/invoke-structured-step.js";
import {
  normalizeRoleCapabilitySelectionReconsiderationCause,
  ROLE_CAPABILITY_RECONSIDERATION_ISSUE_CODE_MAX_LENGTH,
  ROLE_CAPABILITY_RECONSIDERATION_ISSUE_LIMIT_MAX,
  ROLE_CAPABILITY_RECONSIDERATION_ISSUE_PATH_MAX_LENGTH,
  ROLE_CAPABILITY_RECONSIDERATION_STAGE_MAX_LENGTH,
  type RoleCapabilitySelectionReconsiderationCause,
} from "../../orchestration/role-calls/index.js";

export function createRefinementInvalidOutputCause(
  error: StructuredModelInvalidOutputError,
): RoleCapabilitySelectionReconsiderationCause {
  return requireCanonicalCause({
    kind: "refinement_invalid_output",
    validationStage: truncateText(
      error.validationStage,
      ROLE_CAPABILITY_RECONSIDERATION_STAGE_MAX_LENGTH,
    ),
    issues: error.issues
      .slice(0, ROLE_CAPABILITY_RECONSIDERATION_ISSUE_LIMIT_MAX)
      .map(({ code, path }) => ({
        code: truncateText(
          code,
          ROLE_CAPABILITY_RECONSIDERATION_ISSUE_CODE_MAX_LENGTH,
        ),
        path: truncateText(
          path,
          ROLE_CAPABILITY_RECONSIDERATION_ISSUE_PATH_MAX_LENGTH,
        ),
      })),
    repairAttempts: error.repairAttempts,
    repeatedInvalidOutput: error.repeatedInvalidOutput,
  });
}

function truncateText(input: string, maximumLength: number): string {
  return input.trim().slice(0, maximumLength);
}

function requireCanonicalCause(
  input: unknown,
): RoleCapabilitySelectionReconsiderationCause {
  const cause = normalizeRoleCapabilitySelectionReconsiderationCause(input);
  if (!cause) {
    throw new Error("execution_capability_reconsideration_cause_invalid");
  }
  return cause;
}
