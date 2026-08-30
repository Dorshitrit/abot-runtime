import { WORKER_DECISION_ACTIONS, type WorkerDecision } from "../contracts.js";

export function resolveWorkerDecisionAllowedActions(
  params: Readonly<{
    capabilityExecutionPending: boolean;
    capabilitySelectionRejectionPresent: boolean;
    dependencyResultCount: number;
    requestToolResultCount: number;
    canInvokeSingleCapability: boolean;
    canInvokeCapabilityBatch: boolean;
  }>,
): readonly WorkerDecision["action"][] {
  const capabilitySelectionIsReconsidering =
    params.capabilitySelectionRejectionPresent &&
    !params.capabilityExecutionPending;
  const capabilityExecutionWasReaffirmed =
    params.capabilitySelectionRejectionPresent &&
    params.capabilityExecutionPending;
  const canReturnResult =
    !params.capabilityExecutionPending && !capabilitySelectionIsReconsidering;
  const canReturnFailure = !capabilityExecutionWasReaffirmed;

  return Object.freeze([
    ...(canReturnResult ? [WORKER_DECISION_ACTIONS[0]] : []),
    ...(canReturnFailure ? [WORKER_DECISION_ACTIONS[1]] : []),
    ...(params.canInvokeSingleCapability ? [WORKER_DECISION_ACTIONS[2]] : []),
    ...(params.canInvokeCapabilityBatch ? [WORKER_DECISION_ACTIONS[3]] : []),
  ]);
}
