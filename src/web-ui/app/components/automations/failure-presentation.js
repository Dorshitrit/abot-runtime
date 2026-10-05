import { escapeHtml } from "../../lib/text-format.js";

const FAILURE_DESCRIPTIONS = {
  automation_model_call_limit_reached: {
    title: "Model call limit reached",
    reason: "The run used all permitted model calls before its next model invocation.",
    action: "Review model usage below. Increase Model calls / run in Resource limits, save the draft and publish before trying again. The eventual call count depends on the model and workflow.",
  },
  automation_tool_call_limit_reached: {
    title: "Tool call limit reached",
    reason: "The run reached its tool-attempt limit before another tool could be admitted.",
    action: "Review admitted tool attempts below. Adjust Tool calls / run in Resource limits, save the draft and publish before trying again.",
  },
  automation_run_duration_exceeded: {
    scope: "run",
    title: "Run duration limit reached",
    reason: "The run exceeded its configured duration.",
    action: "Review the steps and any recorded effects. If more time is appropriate, increase Run duration in Resource limits, save the draft and publish.",
  },
  automation_budget_exhausted: {
    scope: "run",
    title: "Resource limit reached",
    reason: "A resource limit stopped this run. The recorded error does not identify which limit was reached.",
    action: "Review Execution details and Resource limits. A new run can record a more specific limit reason.",
  },
  automation_agent_context_too_large: {
    title: "Agent input exceeds the model context",
    reason: "The agent request could not fit within the model's available context.",
    action: "Reduce the step's inputs or use a model with more context capacity. Increasing Model calls / run does not increase context capacity.",
  },
  automation_agent_provider_failed: {
    title: "Model provider request failed",
    reason: "The model provider could not complete the agent request.",
    action: "Check that the configured model provider is available, and review any recorded effects before retrying.",
  },
  request_inactivity_timeout: {
    title: "Agent request stopped making progress",
    reason: "No request activity was recorded within the configured inactivity interval.",
    action: "Inspect retained results and tool effects, and check the model provider before retrying. This inactivity limit is separate from the whole-run duration limit.",
  },
  llm_stream_inactivity_timeout: {
    title: "Model stream stopped sending data",
    reason: "The model stream produced no new data within its configured inactivity interval.",
    action: "Check the model provider and inspect recorded effects before retrying. This inactivity limit is separate from the whole-run duration limit.",
  },
  automation_agent_failed: {
    title: "Agent request failed",
    reason: "The saved error does not include a more specific cause for the agent request failure.",
    action: "Inspect the step result and Diagnostics. The recorded information cannot confirm whether a limit, timeout or provider issue caused this failure.",
  },
  automation_run_deadline_elapsed: {
    scope: "run",
    title: "Run deadline elapsed",
    reason: "The run could not complete within its configured deadline.",
    action: "Review completed steps and recorded effects. Check Run duration and Stop report deadline in Resource limits before trying again.",
  },
  automation_stop_deadline_elapsed: {
    scope: "run",
    title: "Stop report deadline reached",
    reason: "The Runtime stopped waiting for this run to finish after the stop report deadline elapsed.",
    action: "Review retained results, uncertain tool effects and any later evidence before starting another run. The cancelled status does not confirm that an external action has stopped.",
  },
  automation_agent_blocked: {
    title: "Agent could not complete the step",
    reason: "The agent reported that it was blocked from completing the requested work.",
    action: "Review its inputs, instructions and allowed tools. Check any saved result for the agent's explanation.",
  },
  automation_agent_acceptance_failed: {
    title: "Agent result did not meet the step conditions",
    reason: "The agent result did not meet this step's acceptance conditions.",
    action: "Review its inputs and any saved output, then check the configured acceptance conditions.",
  },
  automation_dependency_missing: {
    title: "An earlier step result is missing",
    reason: "This step could not receive a required result from an earlier step.",
    action: "Inspect the earlier step and the input connection. Confirm that the source step completes and saves the expected output.",
  },
  automation_output_pointer_invalid: {
    title: "An input connection could not find its value",
    reason: "The configured JSON pointer did not resolve within an earlier step's output.",
    action: "Inspect the source output and correct the input connection's JSON pointer.",
  },
  automation_source_unavailable: {
    title: "A selected source file is unavailable",
    reason: "The run could not access one of its selected input files.",
    action: "Check the folder source and file availability from the Runtime environment.",
  },
  automation_source_changed: {
    title: "A selected source file changed",
    reason: "The input file changed after this run selected its version.",
    action: "Check the source file and start a new run with its current version.",
  },
  automation_source_reader_unavailable: {
    title: "Source reader is unavailable",
    reason: "The Runtime has no available reader for the selected source.",
    action: "Check the configured source reader and its permissions before trying again.",
  },
  automation_source_type_unsupported: {
    title: "Source file type is unsupported",
    reason: "The source reader does not support the selected file type.",
    action: "Use a supported file type or change the source reader.",
  },
  automation_source_capacity_exceeded: {
    title: "Folder source capacity reached",
    reason: "The retained source files or their metadata exceeded a source capacity limit.",
    action: "Review source selection and retained inputs. Narrow the source or reduce the batch size before trying again.",
  },
  automation_operation_unavailable: {
    title: "A required tool operation is unavailable",
    reason: "A selected operation is unavailable or its automation permission is no longer valid.",
    action: "Check installed tools and the automation's Tool permission, then validate and publish the updated draft.",
  },
  automation_approval_required: {
    title: "Tool approval is required",
    reason: "The requested operation needs approval that this unattended run could not obtain.",
    action: "Review the operation and the automation's published tool permissions before running again.",
  },
  automation_model_unavailable: {
    title: "The selected model is unavailable",
    reason: "The agent's configured model profile is not available.",
    action: "Select an available model for the step, save the draft and publish.",
  },
  automation_artifact_budget_exhausted: {
    title: "Saved output capacity reached",
    reason: "The Runtime could not retain another output within the available artifact capacity.",
    action: "Review output size, retained artifacts and Stored artifacts in Resource limits. Capacity may also be constrained by total Runtime storage.",
  },
  automation_effect_uncertain: {
    title: "A tool's outcome is uncertain",
    reason: "The Runtime could not confirm whether a tool finished its action.",
    action: "Inspect the recorded tool effects and actual target before retrying, to avoid repeating an action that may already have happened.",
  },
  automation_run_stopped: {
    scope: "run",
    title: "Run stopped",
    reason: "A stop request interrupted this run.",
    action: "Review any completed steps and recorded effects before starting another run.",
  },
  automation_tool_failed: {
    title: "A tool reported failure",
    reason: "A tool could not complete its requested operation.",
    action: "Inspect the saved tool result and effects for its specific error before retrying.",
  },
  automation_required_operation_missing: {
    title: "A required operation was not completed",
    reason: "The agent finished without a successful receipt for a required tool operation.",
    action: "Review the agent's saved result, instructions and required tools before running again.",
  },
};

const REQUEST_TIMEOUT_PHASES = {
  request_timeout: "Agent request",
  execution_agent_decision_timeout: "Agent decision",
  execution_capability_refinement_timeout: "Tool input selection",
  execution_agent_response_timeout: "Agent response",
  supervisor_decision_timeout: "Supervisor decision",
  supervisor_response_timeout: "Supervisor response",
  supervisor_memory_authoring_timeout: "Session memory authoring",
  planner_decision_timeout: "Planning decision",
  planner_graph_timeout: "Plan authoring",
  worker_decision_timeout: "Worker decision",
  worker_result_timeout: "Worker result",
  worker_capability_payload_timeout: "Tool input preparation",
  reviewer_decision_timeout: "Result review",
  auditor_decision_timeout: "Result audit",
  degraded_finalization_timeout: "Final response",
  context_compaction_timeout: "Context compaction",
  session_memory_compaction_timeout: "Session memory compaction",
};

const REQUEST_OUTPUT_FAILURES = new Set([
  "invalid_supervisor_decision", "invalid_execution_agent_decision", "invalid_planner_decision",
  "invalid_worker_decision", "invalid_reviewer_decision", "invalid_execution_agent_authored_response",
  "invalid_worker_result", "invalid_supervisor_response", "invalid_execution_agent_response",
  "invalid_supervisor_memory_candidates", "invalid_context_compaction_output",
  "invalid_session_memory_compaction_output", "worker_capability_payload_model_output_invalid",
  "invalid_degraded_finalization_output",
]);

function requestFailureDescription(code) {
  const timeoutPhase = Object.hasOwn(REQUEST_TIMEOUT_PHASES, code) ? REQUEST_TIMEOUT_PHASES[code] : "";
  if (timeoutPhase) return {
    title: `${timeoutPhase} timed out`,
    reason: `${timeoutPhase} did not finish before its configured request deadline.`,
    action: "Inspect retained results and tool effects before retrying. This request deadline is separate from the whole-run duration limit.",
  };
  if (REQUEST_OUTPUT_FAILURES.has(code)) return {
    title: "The model response did not match the required format",
    reason: "A model response could not be accepted under the request's required structure.",
    action: "Inspect the step result and technical error. Review the model and its requested output format before trying again.",
  };
  if (code === "context_compaction_projection_not_reduced") return {
    title: "Context could not be reduced",
    reason: "Compaction did not reduce the model context enough to continue safely.",
    action: "Reduce the step's inputs or use a model with more context capacity before trying again.",
  };
  return {
    title: "The step could not finish",
    reason: "This view cannot explain the recorded error.",
    action: "Inspect the step result and the technical error in Diagnostics before retrying.",
  };
}

function normalizeFailureCode(error) {
  if (typeof error !== "string") return "";
  return error.replace(/^Error: /, "");
}

function recordedCallUsage(used, limit, label) {
  const count = Number.isSafeInteger(used) && used >= 0 ? String(used) : "Not recorded";
  if (!Number.isSafeInteger(limit) || limit <= 0) return `${label}: ${count}`;
  return `${label}: ${count} · Published limit: ${limit}`;
}

function failureUsage(code, run) {
  const limits = run?.definition?.limits;
  if (code === "automation_model_call_limit_reached")
    return recordedCallUsage(run?.report?.modelCalls, limits?.maxModelCallsPerRun, "Model calls admitted");
  if (code === "automation_tool_call_limit_reached")
    return recordedCallUsage(run?.report?.toolAttempts, limits?.maxToolCallsPerRun, "Tool attempts admitted");
  if (code !== "automation_run_duration_exceeded") return "";
  const limit = limits?.maxRunDurationMs;
  if (!Number.isSafeInteger(limit) || limit <= 0) return "";
  return `Published run duration limit: ${limit / 1000} seconds`;
}

export function automationFailurePresentation(error, run = null) {
  const code = normalizeFailureCode(error);
  const description = Object.hasOwn(FAILURE_DESCRIPTIONS, code)
    ? FAILURE_DESCRIPTIONS[code] : requestFailureDescription(code);
  return { ...description, usage: failureUsage(code, run) };
}

export function renderAutomationFailure(error, run = null, stepTitle = "") {
  if (!error) return "";
  const failure = automationFailurePresentation(error, run);
  return `<section class="automation-failure-notice" aria-label="Failure reason"><h4>${escapeHtml(failure.title)}</h4>
    ${stepTitle ? `<p class="automation-failure-step" dir="auto">${escapeHtml(stepTitle)}</p>` : ""}
    <p>${escapeHtml(failure.reason)}</p>${failure.usage ? `<p class="automation-failure-usage">${escapeHtml(failure.usage)}</p>` : ""}
    <p class="automation-failure-action">${escapeHtml(failure.action)}</p></section>`;
}

function isRunWideAutomationFailure(code) {
  if (!Object.hasOwn(FAILURE_DESCRIPTIONS, code)) return false;
  return FAILURE_DESCRIPTIONS[code].scope === "run";
}

function hasMatchingFailedStepCause(record, code) {
  if (record.status !== "failed") return false;
  return normalizeFailureCode(record.errorCode) === code;
}

const OUTCOME_FAILURE_STATUSES = {
  failed: ["failed", "interrupted"],
  interrupted: ["interrupted", "failed"],
  cancelled: ["interrupted", "cancelled"],
  completed_with_skips: ["skipped"],
};

function isCompatibleUncertainStep(record, statuses) {
  if (normalizeFailureCode(record.errorCode) !== "automation_effect_uncertain") return false;
  return statuses.includes(record.status);
}

function hasStepFailureAtStatus(record, status) {
  if (record.status !== status) return false;
  return Boolean(normalizeFailureCode(record.errorCode));
}

function findRunFailureStep(records, error, outcome) {
  const code = normalizeFailureCode(error);
  if (isRunWideAutomationFailure(code)) return null;
  if (code) return records.find((record) => hasMatchingFailedStepCause(record, code));
  const statuses = Object.hasOwn(OUTCOME_FAILURE_STATUSES, outcome) ? OUTCOME_FAILURE_STATUSES[outcome] : [];
  const uncertain = records.find((record) => isCompatibleUncertainStep(record, statuses));
  if (uncertain) return uncertain;
  for (const status of statuses) {
    const step = records.find((record) => hasStepFailureAtStatus(record, status));
    if (step) return step;
  }
  return null;
}

export function automationRunFailureCause(run) {
  if (!run) return null;
  const outcome = run.report?.outcome || run.status;
  if (["pending", "running", "stopping", "succeeded"].includes(outcome)) return null;
  const records = Array.isArray(run.report?.nodeResults) ? run.report.nodeResults : run.nodes || [];
  const step = findRunFailureStep(records, run.error, outcome);
  const error = run.error || step?.errorCode || "";
  const stepTitle = isRunWideAutomationFailure(normalizeFailureCode(error)) ? "" : step?.title || "";
  return { error, stepTitle };
}

export function renderAutomationRunFailure(run) {
  const cause = automationRunFailureCause(run);
  if (!cause) return "";
  return renderAutomationFailure(cause.error || "automation_failure_cause_not_recorded", run, cause.stepTitle);
}
