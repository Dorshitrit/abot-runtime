import { MODEL_STEPS } from "../../../shared/model-steps.js";
import {
  normalizeRoleCallWorkingDirectory,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallPlanBinding,
  type RoleCallWorkerCapabilityScope,
} from "../../orchestration/role-calls/index.js";
import {
  isRuntimeDelegateRoleId,
  RUNTIME_DELEGATE_ROLE_IDS,
  type RuntimeDelegateRoleId,
} from "../../orchestration/roles.js";

export const PLANNER_DECISION_MODEL_STEP = MODEL_STEPS.PLANNER_DECISION;
export const PLANNER_ROLE_ID = "planner" as const;
export const PLANNER_CHILD_ROLE_IDS = RUNTIME_DELEGATE_ROLE_IDS;
export const PLANNER_OBJECTIVE_MAX_LENGTH = ROLE_CALL_OBJECTIVE_MAX_LENGTH;
export const PLANNER_RESULT_MAX_LENGTH = ROLE_CALL_RESULT_MAX_LENGTH;
export const PLANNER_DECISION_ACTIONS = Object.freeze([
  "return_result",
  "return_failure",
  "invoke_role",
] as const);
export type PlannerDecisionAction = (typeof PLANNER_DECISION_ACTIONS)[number];
export type PlannerDecisionSelectionKind = PlannerDecisionAction;

export type PlannerChildRoleId = RuntimeDelegateRoleId;

export type PlannerReturnResultDecision = Readonly<{
  action: "return_result";
  result: string;
}>;

export type PlannerReturnFailureDecision = Readonly<{
  action: "return_failure";
  reason: string;
}>;

type PlannerInvokeRoleDecisionBase = Readonly<{
  action: "invoke_role";
  objective: string;
  plannerPlan?: RoleCallPlanBinding;
}>;

export type PlannerInvokeRoleDecision =
  | Readonly<
      PlannerInvokeRoleDecisionBase & {
        roleId: "worker";
        workingDirectory: string;
        workerCapabilityScope?: RoleCallWorkerCapabilityScope;
      }
    >
  | Readonly<
      PlannerInvokeRoleDecisionBase & {
        roleId: Exclude<PlannerChildRoleId, "worker">;
      }
    >;

export type PlannerDecisionPlanContext =
  | Readonly<{
      mode: "declare";
      maxItems: number;
    }>
  | Readonly<{
      mode: "select";
      planId: string;
      summary: string;
      childInvocationAvailable: boolean;
      pendingItems: readonly Readonly<{
        itemId: string;
        title: string;
        objective: string;
      }>[];
    }>
  | Readonly<{
      mode: "extend";
      planId: string;
      summary: string;
      existingItemCount: number;
      maxItems: number;
    }>;

export type PlannerDecision =
  | PlannerReturnResultDecision
  | PlannerReturnFailureDecision
  | PlannerInvokeRoleDecision;

export type PlannerDecisionValidationStage = "json_envelope" | "domain_parser";

export type PlannerDecisionValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type PlannerDecisionParseResult =
  | Readonly<{ ok: true; decision: PlannerDecision }>
  | Readonly<{
      ok: false;
      stage: PlannerDecisionValidationStage;
      issues: readonly PlannerDecisionValidationIssue[];
    }>;

export type PlannerDecisionCallIdentity = Readonly<{
  callId: string;
  parentCallId: string;
  depth: number;
  invocationAttempt: number;
}>;

export type PlannerDecisionDiagnosticContext = Readonly<{
  requestId: string;
  modelStep: typeof PLANNER_DECISION_MODEL_STEP;
}> &
  PlannerDecisionCallIdentity;

export function isPlannerChildRoleId(
  value: unknown,
): value is PlannerChildRoleId {
  return isRuntimeDelegateRoleId(value);
}

export function projectPlannerDecisionCallIdentity(
  call: RoleCallFrame,
): PlannerDecisionCallIdentity {
  if (
    call.roleId !== PLANNER_ROLE_ID ||
    call.parentCallId === null ||
    call.depth < 1 ||
    call.status !== "active" ||
    call.objective === null ||
    call.objective.trim().length === 0 ||
    call.activationCount < 1 ||
    call.resultRef !== null ||
    (call.workingDirectory !== undefined &&
      normalizeRoleCallWorkingDirectory(call.workingDirectory) !==
        call.workingDirectory)
  ) {
    throw new Error("planner_call_frame_invalid");
  }
  return Object.freeze({
    callId: call.callId,
    parentCallId: call.parentCallId,
    depth: call.depth,
    invocationAttempt: call.activationCount,
  });
}
