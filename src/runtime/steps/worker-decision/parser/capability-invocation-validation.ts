import {
  WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH,
  WORKER_CAPABILITY_INTENT_MAX_LENGTH,
  type WorkerDecisionValidationIssue,
} from "../contracts.js";
import type { WorkerCapabilityDescriptor } from "../../../orchestration/worker-capabilities/index.js";
import {
  partitionSelectedCapabilityControls,
  validateCapabilityExecutionControls,
  validateCapabilitySelectionControls,
} from "./capability-controls-validation.js";
import {
  validateBoundedWorkerDecisionText,
  validateExactWorkerDecisionKeys,
} from "./decision-shape-validation.js";
import type {
  ActionValidation,
  CapabilityInvocationValidation,
  CapabilityInvocationValidationInput,
  DecisionValidationContext,
} from "./validation-contract.js";
import {
  createWorkerDecisionIssue,
  hasObservationOnlyCapabilityMismatch,
} from "./validation-contract.js";

export function validateSingleCapabilityDecision(
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  issues: WorkerDecisionValidationIssue[],
): ActionValidation {
  if (hasMissingPendingCapabilityRefinement(context)) {
    issues.push(
      createWorkerDecisionIssue(
        "worker_capability_refinement_invalid",
        "decision.action",
      ),
    );
  }
  const invocation = parseCapabilityInvocation(
    {
      record,
      path: "decision",
      includesActionKey: true,
      observationOnly: false,
      executionRequiresPendingInvocation: true,
      decisionPhase: context.decisionPhase,
      availableCapabilities: context.availableCapabilities,
      pendingInvocation: context.pendingCapabilitySelection,
      pendingSlotId: undefined,
    },
    issues,
  );
  return {
    acceptedControls: invocation.controls,
    acceptedAuthoringObjective: invocation.authoringObjective,
    acceptedSelectionControls: invocation.selectionControls,
  };
}

function hasMissingPendingCapabilityRefinement(
  context: DecisionValidationContext,
): boolean {
  if (context.decisionPhase !== "capability_execution") return false;
  return context.pendingCapabilitySelection === undefined;
}

export function parseCapabilityInvocation(
  params: CapabilityInvocationValidationInput,
  issues: WorkerDecisionValidationIssue[],
): CapabilityInvocationValidation {
  const selectedCapability = resolveCapabilityInvocationDescriptor(
    params,
    issues,
  );
  if (params.decisionPhase === "capability_selection") {
    validateBoundedWorkerDecisionText(
      params.record.intent,
      WORKER_CAPABILITY_INTENT_MAX_LENGTH,
      "worker_capability_intent_invalid",
      `${params.path}.intent`,
      issues,
    );
  }
  const controlsPartition = partitionSelectedCapabilityControls(
    selectedCapability,
    `${params.path}.capabilityId`,
    issues,
  );
  validateExactWorkerDecisionKeys(
    params.record,
    expectedCapabilityInvocationKeys(
      params,
      controlsPartition?.selectionControlIds.length ?? 0,
      selectedCapability,
    ),
    issues,
    params.path,
  );
  const selectionControls = validateCapabilitySelectionControls(
    params,
    selectedCapability,
    controlsPartition,
    issues,
  );
  const controls = validateCapabilityExecutionControls(
    params,
    selectedCapability,
    controlsPartition,
    issues,
  );
  const authoringObjective = validateCapabilityAuthoringObjective(
    params,
    selectedCapability,
    issues,
  );
  return {
    selectedCapability,
    controlsPartition,
    authoringObjective,
    selectionControls,
    controls,
  };
}

function resolveCapabilityInvocationDescriptor(
  params: CapabilityInvocationValidationInput,
  issues: WorkerDecisionValidationIssue[],
): WorkerCapabilityDescriptor | undefined {
  if (params.pendingInvocation) {
    return params.availableCapabilities.find(
      (capability) =>
        capability.capabilityId === params.pendingInvocation?.capabilityId,
    );
  }
  if (executionRequiresPendingCapabilityInvocation(params)) return undefined;
  if (typeof params.record.capabilityId !== "string") {
    issues.push(
      createWorkerDecisionIssue(
        "worker_capability_id_invalid",
        `${params.path}.capabilityId`,
      ),
    );
    return undefined;
  }
  const selectedCapability = params.availableCapabilities.find(
    (capability) => capability.capabilityId === params.record.capabilityId,
  );
  if (!selectedCapability) {
    issues.push(
      createWorkerDecisionIssue(
        "worker_capability_unavailable",
        `${params.path}.capabilityId`,
      ),
    );
    return undefined;
  }
  if (hasObservationOnlyCapabilityMismatch(params, selectedCapability)) {
    issues.push(
      createWorkerDecisionIssue(
        "worker_capability_batch_effect_invalid",
        `${params.path}.capabilityId`,
      ),
    );
  }
  return selectedCapability;
}

function executionRequiresPendingCapabilityInvocation(
  params: CapabilityInvocationValidationInput,
): boolean {
  if (params.decisionPhase !== "capability_execution") return false;
  return params.executionRequiresPendingInvocation;
}

function expectedCapabilityInvocationKeys(
  params: Pick<
    CapabilityInvocationValidationInput,
    "includesActionKey" | "decisionPhase"
  >,
  selectionControlCount: number,
  selectedCapability: WorkerCapabilityDescriptor | undefined,
): string[] {
  const keys = params.includesActionKey ? ["action"] : [];
  if (params.decisionPhase === "capability_execution") {
    keys.push("controls");
    return keys;
  }
  keys.push("capabilityId", "intent");
  if (selectedCapability?.requiresPayloadAuthoringObjective) {
    keys.push("authoringObjective");
  }
  if (selectionControlCount > 0) keys.push("selectionControls");
  return keys;
}

function validateCapabilityAuthoringObjective(
  params: CapabilityInvocationValidationInput,
  selectedCapability: WorkerCapabilityDescriptor | undefined,
  issues: WorkerDecisionValidationIssue[],
): string | undefined {
  if (!selectedCapability?.requiresPayloadAuthoringObjective) return undefined;
  if (params.decisionPhase === "capability_execution") {
    return params.pendingInvocation?.authoringObjective;
  }
  validateBoundedWorkerDecisionText(
    params.record.authoringObjective,
    WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH,
    "worker_capability_authoring_objective_invalid",
    `${params.path}.authoringObjective`,
    issues,
  );
  const value = params.record.authoringObjective;
  if (typeof value !== "string") return undefined;
  if (value.trim().length === 0) return undefined;
  if (value.length > WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH) {
    return undefined;
  }
  return value.trim();
}
