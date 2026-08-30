import type { ChatMessage } from "../../../model-gateway/types.js";
import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import {
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallDependencyResult,
} from "../../orchestration/role-calls/index.js";
import type {
  WorkerCapabilityControls,
  WorkerCapabilityInvocation,
  WorkerSettledCapabilityResult,
} from "../../orchestration/worker-capabilities/index.js";
import { CAPABILITY_CONTROLS_MODEL_STEP } from "../../orchestration/worker-capabilities/index.js";
export { WORKER_CAPABILITY_INTENT_MAX_LENGTH } from "../../orchestration/worker-capabilities/index.js";
export { WORKER_CAPABILITY_AUTHORING_OBJECTIVE_MAX_LENGTH } from "../../orchestration/worker-capabilities/index.js";

export const WORKER_DECISION_MODEL_STEP = MODEL_STEPS.WORKER_DECISION;
export const WORKER_RESULT_MODEL_STEP = MODEL_STEPS.WORKER_RESULT;
export { CAPABILITY_CONTROLS_MODEL_STEP };
export const WORKER_ROLE_ID = "worker" as const;
export const WORKER_RESULT_MAX_LENGTH = ROLE_CALL_RESULT_MAX_LENGTH;
export const WORKER_DECISION_ACTIONS = Object.freeze([
  "return_result",
  "return_failure",
  "invoke_capability",
  "invoke_capabilities",
] as const);
export const WORKER_DECISION_PHASES = Object.freeze([
  "capability_selection",
  "capability_execution",
] as const);
export type WorkerDecisionPhase = (typeof WORKER_DECISION_PHASES)[number];

export type WorkerReturnResultSelection = Readonly<{
  action: "return_result";
}>;

export type WorkerReturnResultDecision = Readonly<{
  action: "return_result";
  result: string;
}>;

export type WorkerReturnFailureDecision = Readonly<{
  action: "return_failure";
  reason: string;
}>;

export type WorkerInvokeCapabilityDecision = Readonly<{
  action: "invoke_capability";
  capabilityId: string;
  intent: string;
  authoringObjective?: string;
  controls: WorkerCapabilityControls;
}>;

export type WorkerInvokeCapabilitySelection = Readonly<{
  action: "invoke_capability";
  capabilityId: string;
  intent: string;
  authoringObjective?: string;
  selectionControls?: WorkerCapabilityControls;
}>;

export type WorkerInvokeCapabilitiesDecision = Readonly<{
  action: "invoke_capabilities";
  invocations: readonly WorkerCapabilityInvocation[];
}>;

export type WorkerInvokeCapabilitiesSelection = Readonly<{
  action: "invoke_capabilities";
  invocations: readonly Readonly<{
    capabilityId: string;
    intent: string;
    authoringObjective?: string;
    selectionControls?: WorkerCapabilityControls;
  }>[];
}>;

export type WorkerDecision =
  | WorkerReturnResultDecision
  | WorkerReturnFailureDecision
  | WorkerInvokeCapabilityDecision
  | WorkerInvokeCapabilitiesDecision;

export type WorkerDecisionStepResult =
  | WorkerDecision
  | WorkerInvokeCapabilitySelection
  | WorkerInvokeCapabilitiesSelection;

export type WorkerControlDecision =
  | WorkerReturnResultSelection
  | WorkerReturnFailureDecision
  | WorkerInvokeCapabilitySelection
  | WorkerInvokeCapabilitiesSelection
  | WorkerInvokeCapabilityDecision
  | WorkerInvokeCapabilitiesDecision;

export type { WorkerSettledCapabilityResult };

export type WorkerCapabilityResumeContext =
  | Readonly<{
      requestId: string;
      returnedExecutionId: string;
      settledResults: readonly WorkerSettledCapabilityResult[];
    }>
  | Readonly<{
      requestId: string;
      returnedExecutionIds: readonly string[];
      settledResults: readonly WorkerSettledCapabilityResult[];
    }>;

export type WorkerDecisionValidationStage = "json_envelope" | "domain_parser";

export type WorkerDecisionValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type WorkerDecisionParseResult =
  | Readonly<{ ok: true; decision: WorkerControlDecision }>
  | Readonly<{
      ok: false;
      stage: WorkerDecisionValidationStage;
      issues: readonly WorkerDecisionValidationIssue[];
    }>;

export type WorkerDecisionCallIdentity = Readonly<{
  callId: string;
  parentCallId: string;
  depth: number;
  invocationAttempt: number;
}>;

export type WorkerResultAuthorSource = WorkerDecisionCallIdentity &
  Readonly<{
    objective: string;
    dependencyResults: readonly RoleCallDependencyResult[];
    requestToolResults: RequestToolResultsView;
    requestToolResultsContextMessage?: ChatMessage;
    operationSupervisionEvidenceContextMessage?: ChatMessage;
  }>;

export type WorkerDecisionDiagnosticContext = Readonly<{
  requestId: string;
  modelStep:
    | typeof WORKER_DECISION_MODEL_STEP
    | typeof CAPABILITY_CONTROLS_MODEL_STEP;
  decisionPhase: WorkerDecisionPhase;
}> &
  WorkerDecisionCallIdentity;

export function projectWorkerDecisionCallIdentity(
  call: RoleCallFrame,
): WorkerDecisionCallIdentity {
  if (
    call.roleId !== WORKER_ROLE_ID ||
    call.parentCallId === null ||
    call.depth < 1 ||
    call.status !== "active" ||
    call.objective === null ||
    call.objective.trim().length === 0 ||
    call.resultRef !== null
  ) {
    throw new Error("worker_call_frame_invalid");
  }
  return Object.freeze({
    callId: call.callId,
    parentCallId: call.parentCallId,
    depth: call.depth,
    invocationAttempt: call.activationCount,
  });
}
