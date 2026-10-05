const MODEL_CONTEXT_CAPACITY_FAILURES = new Set([
  "request_context_final_envelope_exceeds_window",
  "model_context_window_exceeded",
  "request_context_compaction_required",
  "context_compaction_sources_empty",
]);

const KNOWN_REQUEST_FAILURE_CODES = new Set([
  "automation_budget_exhausted",
  "automation_model_call_limit_reached",
  "automation_tool_call_limit_reached",
  "automation_run_duration_exceeded",
  "automation_artifact_budget_exhausted",
  "automation_run_deadline_elapsed",
  "automation_operation_unavailable",
  "request_timeout",
  "request_inactivity_timeout",
  "llm_stream_inactivity_timeout",
  "execution_agent_decision_timeout",
  "execution_capability_refinement_timeout",
  "execution_agent_response_timeout",
  "supervisor_decision_timeout",
  "supervisor_response_timeout",
  "supervisor_memory_authoring_timeout",
  "planner_decision_timeout",
  "planner_graph_timeout",
  "worker_decision_timeout",
  "worker_result_timeout",
  "worker_capability_payload_timeout",
  "reviewer_decision_timeout",
  "auditor_decision_timeout",
  "degraded_finalization_timeout",
  "context_compaction_timeout",
  "session_memory_compaction_timeout",
  "invalid_supervisor_decision",
  "invalid_execution_agent_decision",
  "invalid_planner_decision",
  "invalid_worker_decision",
  "invalid_reviewer_decision",
  "invalid_execution_agent_authored_response",
  "invalid_worker_result",
  "invalid_supervisor_response",
  "invalid_execution_agent_response",
  "invalid_supervisor_memory_candidates",
  "invalid_degraded_finalization_output",
  "invalid_context_compaction_output",
  "invalid_session_memory_compaction_output",
  "worker_capability_payload_model_output_invalid",
  "context_compaction_projection_not_reduced",
]);

function isModelContextCapacityFailure(code: string): boolean {
  return MODEL_CONTEXT_CAPACITY_FAILURES.has(code);
}

function isKnownRequestFailureCode(code: string): boolean {
  return KNOWN_REQUEST_FAILURE_CODES.has(code);
}

function isKnownModelProviderFailure(code: string): boolean {
  if (code === "no stream") return true;
  if (code.startsWith("model_stream_error: ")) return true;
  return /^bridge_(?:request_failed|raw_failed):[1-5][0-9]{2}:/u.test(code);
}

/** Preserve exact known causes; provider content never enters automation receipts. */
export function automationAgentRequestFailureCode(error: unknown): string {
  if (typeof error !== "string") return "automation_agent_failed";
  if (isModelContextCapacityFailure(error)) return "automation_agent_context_too_large";
  if (isKnownRequestFailureCode(error)) return error;
  if (isKnownModelProviderFailure(error)) return "automation_agent_provider_failed";
  return "automation_agent_failed";
}
