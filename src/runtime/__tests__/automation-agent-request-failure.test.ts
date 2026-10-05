import { expect, test } from "vitest";
import { automationAgentRequestFailureCode } from "../automations/agent-request-failure.js";

test.each([
  "request_context_final_envelope_exceeds_window",
  "model_context_window_exceeded",
  "request_context_compaction_required",
  "context_compaction_sources_empty",
])("preserves the context failure category for %s", (error) => {
  expect(automationAgentRequestFailureCode(error)).toBe("automation_agent_context_too_large");
});

const preservedFailureCodes = [
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
];

test.each(preservedFailureCodes)("preserves the exact known request failure %s", (error) => {
  expect(automationAgentRequestFailureCode(error)).toBe(error);
});

test.each(preservedFailureCodes)("rejects private content appended to known code %s", (error) => {
  expect(automationAgentRequestFailureCode(`${error}: private provider response`))
    .toBe("automation_agent_failed");
});

test.each([
  "bridge_request_failed:429:private credentials and provider response",
  "bridge_raw_failed:503:private provider response",
  "model_stream_error: quota exceeded\nprivate payload",
  "no stream",
])("categorizes a known provider failure without exposing its body %s", (error) => {
  expect(automationAgentRequestFailureCode(error)).toBe("automation_agent_provider_failed");
});

test.each([
  undefined, null, { message: "model_context_window_exceeded" },
  "provider_failure", "model_context_window_exceeded: private provider response",
  "context_compaction_schema_invalid", "private_operation_timeout",
  "invalid_private_operation", "automation_private_error",
  "bridge_request_failed:private response", "bridge_raw_failed:999:private response",
  "prefix bridge_request_failed:429:private response", "model_stream_error_private_body",
  "no stream: private response", "request_timeout\nprivate response",
  " automation_model_call_limit_reached", "automation_budget_exhausted ",
])("does not expose or misclassify an unrelated request failure %j", (error) => {
  expect(automationAgentRequestFailureCode(error)).toBe("automation_agent_failed");
});
