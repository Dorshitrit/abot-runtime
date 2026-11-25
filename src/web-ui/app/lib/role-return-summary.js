const MODEL_FAILURE_FIELDS = [
  "kind", "authority", "presenceEffect", "callId", "parentCallId", "roleId",
  "reason", "modelStep", "validationStage",
];

const INVALID_MODEL_OUTPUT_REASONS = new Set([
  "invalid_planner_decision",
  "invalid_context_compaction_output",
  "invalid_session_memory_compaction_output",
  "invalid_super_compaction_coverage_output",
  "invalid_super_compaction_content_output",
  "invalid_super_compaction_merge_output",
  "invalid_super_compaction_continuation_output",
]);

function hasModelFailureCapsuleFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== MODEL_FAILURE_FIELDS.length) return false;
  return MODEL_FAILURE_FIELDS.every((key) =>
    typeof value[key] === "string" && value[key].trim().length > 0);
}

function isMatchingPlannerModelFailure(value, receipt) {
  if (!hasModelFailureCapsuleFields(value)) return false;
  if (value.kind !== "runtime_role_model_output_failure_v1") return false;
  if (value.authority !== "runtime_validation") return false;
  if (value.presenceEffect !== "passive_failure_not_work_or_review_evidence") return false;
  if (receipt.callerRole !== "supervisor" || receipt.childRole !== "planner") return false;
  if (value.roleId !== receipt.childRole) return false;
  if (value.callId !== receipt.childCallId) return false;
  return value.parentCallId === receipt.callerCallId;
}

function describePlannerModelFailure(failure) {
  if (failure.reason === "model_provider_failure")
    return "The Planner could not finish because a model request failed.";
  if (failure.validationStage === "model_step_timeout")
    return "The Planner could not finish because a model request timed out.";
  if (failure.reason === "output_incomplete")
    return "The Planner could not finish because the model response was incomplete.";
  if (INVALID_MODEL_OUTPUT_REASONS.has(failure.reason))
    return "The Planner could not finish because the model returned an invalid response.";
  return "The Planner could not complete a model step.";
}

/** Formats a bound Runtime failure for display without changing its canonical receipt. */
export function formatRoleReturnSummary(receipt) {
  if (receipt.outcome !== "failed") return receipt.summary;
  let failure;
  try {
    failure = JSON.parse(receipt.summary);
  } catch {
    return receipt.summary;
  }
  if (!isMatchingPlannerModelFailure(failure, receipt)) return receipt.summary;
  return describePlannerModelFailure(failure);
}
