import { MODEL_STEPS } from "../../../shared/model-steps.js";
import {
  isRuntimeDelegateRoleId,
  RUNTIME_DELEGATE_ROLE_IDS,
  RUNTIME_ROOT_ROLE_ID,
  type RuntimeDelegateRoleId,
} from "../../orchestration/roles.js";
import type {
  RoleCapabilityDeclaredEffect,
  RoleChildReturnContext,
  RoleCallWorkerCapabilityScope,
} from "../../orchestration/role-calls/index.js";

export const SUPERVISOR_DECISION_MODEL_STEP = MODEL_STEPS.SUPERVISOR_DECISION;

export const SUPERVISOR_ROLE_ID = RUNTIME_ROOT_ROLE_ID;
export const SUPERVISOR_DELEGATE_ROLE_IDS = RUNTIME_DELEGATE_ROLE_IDS;
export const SUPERVISOR_DECISION_ACTIONS = Object.freeze([
  "respond",
  "invoke_role",
] as const);
export const SUPERVISOR_ACKNOWLEDGEMENT_MAX_LENGTH = 220;
export const SUPERVISOR_TITLE_MAX_LENGTH = 80;
export const SUPERVISOR_OBJECTIVE_MAX_LENGTH = 8_192;
export const SUPERVISOR_DECISION_PHASES = Object.freeze([
  "routing",
  "working_directory",
] as const);

export type SupervisorDelegateRoleId = RuntimeDelegateRoleId;

export type SupervisorWorkerCapabilityAffordance = Readonly<{
  purpose: string;
  effect: RoleCapabilityDeclaredEffect;
}>;

export type SupervisorRespondDecision = Readonly<{
  action: "respond";
  acknowledgement?: string;
  title?: string;
}>;

export type SupervisorDecisionPhase =
  (typeof SUPERVISOR_DECISION_PHASES)[number];

type SupervisorInvokeRoleDecisionBase = Readonly<{
  action: "invoke_role";
  objective: string;
  acknowledgement?: string;
  title?: string;
}>;

export type SupervisorInvokeRoleDecision =
  | Readonly<
      SupervisorInvokeRoleDecisionBase & {
        roleId: "worker";
        workingDirectory: string;
        workerCapabilityScope?: RoleCallWorkerCapabilityScope;
      }
    >
  | Readonly<
      SupervisorInvokeRoleDecisionBase & {
        roleId: "planner";
        workingDirectory: string;
      }
    >
  | Readonly<
      SupervisorInvokeRoleDecisionBase & {
        roleId: Exclude<SupervisorDelegateRoleId, "planner" | "worker">;
      }
    >;

export type SupervisorDecision =
  | SupervisorRespondDecision
  | SupervisorInvokeRoleDecision;

export type SupervisorDecisionOutcome = Readonly<{
  decision: SupervisorDecision;
  steeringVersion: number;
}>;

export type SupervisorRoutingInvokeRoleDecision =
  | Readonly<
      SupervisorInvokeRoleDecisionBase & {
        roleId: "worker";
        workerCapabilityScope?: RoleCallWorkerCapabilityScope;
      }
    >
  | Readonly<
      SupervisorInvokeRoleDecisionBase & {
        roleId: "planner";
      }
    >
  | Readonly<
      SupervisorInvokeRoleDecisionBase & {
        roleId: Exclude<SupervisorDelegateRoleId, "planner" | "worker">;
      }
    >;

export type SupervisorRoutingDecision =
  | SupervisorRespondDecision
  | SupervisorRoutingInvokeRoleDecision;

export type SupervisorWorkingDirectoryRoutingDecision = Extract<
  SupervisorRoutingInvokeRoleDecision,
  Readonly<{ roleId: "planner" | "worker" }>
>;

export type SupervisorWorkingDirectoryDecision = Readonly<{
  workingDirectory: string;
}>;

export type SupervisorDecisionValidationStage =
  | "json_envelope"
  | "domain_parser";

export type SupervisorDecisionValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type SupervisorDecisionParseResult =
  | Readonly<{ ok: true; decision: SupervisorDecision }>
  | Readonly<{
      ok: false;
      stage: SupervisorDecisionValidationStage;
      issues: readonly SupervisorDecisionValidationIssue[];
    }>;

export type SupervisorRoutingDecisionParseResult =
  | Readonly<{ ok: true; decision: SupervisorRoutingDecision }>
  | Readonly<{
      ok: false;
      stage: SupervisorDecisionValidationStage;
      issues: readonly SupervisorDecisionValidationIssue[];
    }>;

export type SupervisorWorkingDirectoryParseResult =
  | Readonly<{ ok: true; decision: SupervisorWorkingDirectoryDecision }>
  | Readonly<{
      ok: false;
      stage: SupervisorDecisionValidationStage;
      issues: readonly SupervisorDecisionValidationIssue[];
    }>;

export type SupervisorDecisionDiagnosticContext = Readonly<{
  requestId: string;
  modelStep: typeof SUPERVISOR_DECISION_MODEL_STEP;
  decisionPhase?: SupervisorDecisionPhase;
  rootCallId?: string;
  callId?: string;
  parentCallId?: string | null;
  depth?: number;
  invocationAttempt?: number;
}>;

export type SupervisorDecisionCallIdentity = Readonly<{
  rootCallId: string;
  callId: string;
  parentCallId: string | null;
  depth: number;
  invocationAttempt: number;
}>;

export type SupervisorResumeContext = RoleChildReturnContext;

export function isSupervisorDelegateRoleId(
  value: unknown,
): value is SupervisorDelegateRoleId {
  return isRuntimeDelegateRoleId(value);
}
