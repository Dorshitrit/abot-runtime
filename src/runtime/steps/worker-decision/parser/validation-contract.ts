import type {
  WorkerControlDecision,
  WorkerDecisionPhase,
  WorkerDecisionValidationIssue,
} from "../contracts.js";
import { WORKER_DECISION_ACTIONS } from "../contracts.js";
import type {
  WorkerCapabilityControls,
  WorkerCapabilityControlsPartition,
  WorkerCapabilityDescriptor,
} from "../../../orchestration/worker-capabilities/index.js";

export type WorkerDecisionAction = WorkerControlDecision["action"];

export type PendingCapabilityInvocation = Readonly<{
  capabilityId: string;
  intent: string;
  authoringObjective?: string;
  selectionControls?: WorkerCapabilityControls;
}>;

export type AcceptedCapabilityInvocation = Readonly<{
  capabilityId: string;
  intent: string;
  authoringObjective?: string;
  selectionControls?: WorkerCapabilityControls;
  controls?: WorkerCapabilityControls;
}>;

export type DecisionValidationContext = Readonly<{
  decisionPhase: WorkerDecisionPhase;
  allowedActions: readonly WorkerDecisionAction[];
  pendingCapabilitySelection?: PendingCapabilityInvocation;
  pendingCapabilityBatchSelection?: readonly PendingCapabilityInvocation[];
  availableCapabilities: readonly WorkerCapabilityDescriptor[];
  maxBatchCapabilityExecutions: number;
}>;

export type ActionValidation = Readonly<{
  acceptedControls?: WorkerCapabilityControls;
  acceptedAuthoringObjective?: string;
  acceptedSelectionControls?: WorkerCapabilityControls;
  acceptedBatchInvocations?: readonly AcceptedCapabilityInvocation[];
}>;

export type CapabilityInvocationValidation = Readonly<{
  selectedCapability?: WorkerCapabilityDescriptor;
  controlsPartition?: WorkerCapabilityControlsPartition;
  authoringObjective?: string;
  selectionControls?: WorkerCapabilityControls;
  controls?: WorkerCapabilityControls;
}>;

export type CapabilityInvocationValidationInput = Readonly<{
  record: Record<string, unknown>;
  path: string;
  includesActionKey: boolean;
  observationOnly: boolean;
  executionRequiresPendingInvocation: boolean;
  decisionPhase: WorkerDecisionPhase;
  availableCapabilities: readonly WorkerCapabilityDescriptor[];
  pendingInvocation: PendingCapabilityInvocation | undefined;
  pendingSlotId: string | undefined;
}>;

export function hasObservationOnlyCapabilityMismatch(
  params: Pick<CapabilityInvocationValidationInput, "observationOnly">,
  selectedCapability: WorkerCapabilityDescriptor,
): boolean {
  if (!params.observationOnly) return false;
  return selectedCapability.effect !== "observation";
}

export function createWorkerDecisionIssue(
  code: string,
  path: string,
  message?: string,
): WorkerDecisionValidationIssue {
  return {
    code,
    path,
    message: message ?? defaultWorkerDecisionIssueMessage(code),
  };
}

function defaultWorkerDecisionIssueMessage(code: string): string {
  if (code === "worker_action_invalid") {
    return `Action must be one of: ${WORKER_DECISION_ACTIONS.join(", ")}.`;
  }
  return `Worker decision failed ${code}.`;
}
