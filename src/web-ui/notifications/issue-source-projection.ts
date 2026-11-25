import type { NotificationIssueOccurrence, NotificationIssueOutcome } from "./issue-contracts.js";
import { issueOccurrenceHash } from "./issue-receipts.js";
import { getModelParameterDefinition } from "../../shared/model-parameter-validation.js";
import { readModelParameterOmissions, type ParameterOmissionReason } from "../../model-gateway/protocol/parameter-omissions.js";
import { isNotificationIdentifier as id, isNotificationRecord as record, isNotificationTimestamp as timestamp } from "./storage-fields.js";

const LOCAL_OMISSION_REASONS: Readonly<Record<ParameterOmissionReason, string>> = {
  model_reasoning_effort_omitted: "this reasoning level is not supported",
  model_parameter_unsupported: "this parameter is not supported by the model or provider",
  model_parameter_value_omitted: "this value is not valid for the model or provider",
  model_thinking_off_unsupported: "this model does not support disabling thinking",
  model_thinking_off_unverified: "support for disabling thinking is not declared",
  model_parameter_requirement_unsatisfied: "another required setting is missing or incompatible",
};

/** Names and reasons come from declarations, never a provider response or free-form warning. */
function localOmissionPresentation(value: unknown): { hash: string; description: string; count: number } | undefined {
  const omissions = readModelParameterOmissions(value);
  if (!omissions) return;
  const facts = [...omissions].sort((left, right) => left.parameter < right.parameter ? -1 : left.parameter === right.parameter ? 0 : 1);
  const description = facts.map((fact) => {
    const label = getModelParameterDefinition(fact.parameter)!.label;
    const requested = fact.requestedValue === undefined ? "" : ` (${fact.requestedValue})`;
    return `${label}${requested}: ${LOCAL_OMISSION_REASONS[fact.reasonCode]}`;
  }).join("; ");
  return { hash: issueOccurrenceHash("local-parameter-omissions", JSON.stringify(facts)), description, count: facts.length };
}

/** Correlation is scoped to the exact committed request, not provider text or a session-wide guess. */
export function modelIssueNamespace(sessionId: string, requestId: string): string {
  return `model:${issueOccurrenceHash(sessionId, requestId)}`;
}

export function linkedTerminalIssue(event: Record<string, unknown>): { namespace: string; occurrenceId: string } | undefined {
  if (event.type !== "failed" || !id(event.sessionId) || !id(event.requestId) || !record(event.details) || !id(event.details.sourceIssueId)) return;
  return { namespace: modelIssueNamespace(event.sessionId, event.requestId), occurrenceId: event.details.sourceIssueId };
}

/** Known sources own copy and allowlisted configuration; the grouping/store mechanism is source agnostic. */
export function projectNotificationIssue(event: Record<string, unknown>): NotificationIssueOccurrence | undefined {
  const timeout = event.name === "model.step.timed_out";
  const localOmission = event.name === "model.issue.observed" && event.code === "model_parameter_omitted";
  if (!timeout && !localOmission && (event.name !== "model.issue.observed" || event.code !== "model_reasoning_rejected")) return;
  const environmentId = event.environment ?? event.environmentId;
  if (!id(environmentId) || !id(event.sessionId) || !id(event.requestId) || !id(event.invocationId) ||
    !id(event.profileId) || !id(event.provider) || !id(event.model) || !id(event.modelStep) ||
    !id(event.issueId) || !timestamp(event.occurredAt)) return;
  const source = { sessionId: event.sessionId, requestId: event.requestId };
  const common = { environmentId, namespace: modelIssueNamespace(source.sessionId, source.requestId),
    occurrenceId: event.issueId, occurredAt: event.occurredAt, source };
  const provider = id(event.providerId) ? event.providerId : event.provider;
  if (localOmission) {
    const omitted = localOmissionPresentation(event.parameterOmissions);
    if (!omitted || event.outcome !== "recovered" || event.recovery !== "parameter_omitted" ||
      !["chat", "raw", "input_tokens"].includes(String(event.operation))) return;
    return { ...common, outcome: "recovered",
      title: omitted.count === 1 ? "Model setting was omitted" : "Model settings were omitted",
      body: `ABot omitted settings before sending a request for model profile "${event.profileId}". ${omitted.description}. Review this profile's model settings.`,
      grouping: { source: "model-local-parameters", provider, profile: event.profileId, cause: "model_parameter_omitted",
        remediationTarget: event.profileId, configuration: { model: event.model, omissions: omitted.hash, operation: String(event.operation) } },
      action: { kind: "model-settings", profileId: event.profileId },
    };
  }
  if (timeout) {
    if (!timestamp(event.timeoutMs) || !event.timeoutMs || !timestamp(event.configuredTimeoutMs) ||
      !id(event.timeoutSource)) return;
    const profileId = id(event.configurationProfileId) ? event.configurationProfileId : event.profileId;
    const slot = id(event.calibrationSlotId) ? event.calibrationSlotId : "";
    return { ...common, outcome: "failed", title: "Model step timed out",
      body: `Model profile "${event.profileId}" exceeded its ${event.modelStep} step timeout. Review the timeout and increase it if this step needs more time.`,
      grouping: { source: "model", provider, profile: event.profileId, cause: "model_step_timeout",
        remediationTarget: profileId, configuration: { model: event.model, modelStep: event.modelStep,
          timeoutMs: event.timeoutMs, configuredTimeoutMs: event.configuredTimeoutMs,
          timeoutSource: event.timeoutSource, calibrationSlotId: slot } },
      action: { kind: "step-timeout", reference: { environment: environmentId, ...source, invocationId: event.invocationId } },
    };
  }
  if (event.parameter !== "reasoning_effort" || !id(event.requestedValue) ||
    !["recovered", "failed", "interrupted"].includes(String(event.outcome))) return;
  const outcome = event.outcome as NotificationIssueOutcome;
  const recovery = outcome === "recovered" ? "The request continued using the provider default." :
    outcome === "interrupted" ? "The recovery attempt was interrupted." : "The recovery attempt did not finish successfully.";
  return { ...common, outcome, title: "Model reasoning setting was rejected",
    body: `The provider rejected the reasoning level for model profile "${event.profileId}". ${recovery} Review this model's reasoning setting.`,
    grouping: { source: "model", provider, profile: event.profileId, cause: "model_reasoning_rejected",
      remediationTarget: event.profileId, configuration: { model: event.model, parameter: "reasoning_effort",
        requestedValue: event.requestedValue, operation: id(event.operation) ? event.operation : "chat" } },
    action: { kind: "model-settings", profileId: event.profileId },
  };
}
