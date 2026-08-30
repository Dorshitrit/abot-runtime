import type { WorkerControlDecision } from "../contracts.js";
import type {
  AcceptedCapabilityInvocation,
  ActionValidation,
  DecisionValidationContext,
  WorkerDecisionAction,
} from "./validation-contract.js";

export function buildAcceptedWorkerDecision(
  action: WorkerDecisionAction,
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  validation: ActionValidation,
): WorkerControlDecision {
  switch (action) {
    case "return_result":
      return { action: "return_result" };
    case "return_failure":
      return {
        action: "return_failure",
        reason: (record.reason as string).trim(),
      };
    case "invoke_capability":
      return buildAcceptedSingleCapabilityDecision(record, context, validation);
    case "invoke_capabilities":
      return buildAcceptedCapabilityBatchDecision(context, validation);
  }
}

function buildAcceptedSingleCapabilityDecision(
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  validation: ActionValidation,
): Extract<WorkerControlDecision, { action: "invoke_capability" }> {
  const capabilityId =
    context.pendingCapabilitySelection?.capabilityId ??
    (record.capabilityId as string);
  const intent =
    context.pendingCapabilitySelection?.intent ??
    (record.intent as string).trim();
  const authoringObjective =
    context.pendingCapabilitySelection?.authoringObjective ??
    validation.acceptedAuthoringObjective;
  const acceptedInvocation = {
    action: "invoke_capability" as const,
    capabilityId,
    intent,
    ...(authoringObjective ? { authoringObjective } : {}),
  };
  if (context.decisionPhase === "capability_execution") {
    return {
      ...acceptedInvocation,
      controls: validation.acceptedControls!,
    };
  }
  if (validation.acceptedSelectionControls) {
    return {
      ...acceptedInvocation,
      selectionControls: validation.acceptedSelectionControls,
    };
  }
  return acceptedInvocation;
}

function buildAcceptedCapabilityBatchDecision(
  context: DecisionValidationContext,
  validation: ActionValidation,
): Extract<WorkerControlDecision, { action: "invoke_capabilities" }> {
  return {
    action: "invoke_capabilities",
    invocations: Object.freeze(
      validation.acceptedBatchInvocations!.map((invocation) =>
        projectAcceptedCapabilityInvocation(context, invocation),
      ),
    ),
  };
}

function projectAcceptedCapabilityInvocation(
  context: DecisionValidationContext,
  invocation: AcceptedCapabilityInvocation,
): Extract<
  WorkerControlDecision,
  { action: "invoke_capabilities" }
>["invocations"][number] {
  const acceptedInvocation = {
    capabilityId: invocation.capabilityId,
    intent: invocation.intent,
    ...(invocation.authoringObjective
      ? { authoringObjective: invocation.authoringObjective }
      : {}),
  };
  if (context.decisionPhase === "capability_execution") {
    return Object.freeze({
      ...acceptedInvocation,
      controls: invocation.controls!,
    });
  }
  if (invocation.selectionControls) {
    return Object.freeze({
      ...acceptedInvocation,
      selectionControls: invocation.selectionControls,
    });
  }
  return Object.freeze(acceptedInvocation);
}
