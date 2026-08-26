import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type { RoleCapabilitySelectionProjection } from "../../orchestration/role-calls/index.js";
import {
  CAPABILITY_CATALOG_GROUP_COUNT_MAX,
  type CapabilityControls,
  type CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";

export const EXECUTION_AGENT_DECISION_MODEL_STEP =
  MODEL_STEPS.EXECUTION_DECISION;
export const EXECUTION_DECISION_MODEL_STEP =
  EXECUTION_AGENT_DECISION_MODEL_STEP;
export const EXECUTION_AGENT_RESPONSE_MODEL_STEP =
  MODEL_STEPS.EXECUTION_RESPONSE;

export const EXECUTION_AGENT_DECISION_ACTIONS = Object.freeze([
  "open_capability_scope",
  "respond",
  "blocked",
  "invoke_capability",
  "invoke_capabilities",
  "extend_capability_scope",
  "invoke_planner",
  "invoke_auditor",
] as const);

export const EXECUTION_AGENT_RESPONSE_MAX_LENGTH = 65_536;
export const EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH = 8_192;
export const EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH = 220;
export const EXECUTION_AGENT_TITLE_MAX_LENGTH = 80;
export const EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH = 128;
export const EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX = 32;
export const EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX =
  CAPABILITY_CATALOG_GROUP_COUNT_MAX;

export type ExecutionAgentDecisionAction =
  (typeof EXECUTION_AGENT_DECISION_ACTIONS)[number];

export type ExecutionAgentDecisionPresentation = Readonly<{
  acknowledgement?: string;
  title?: string;
}>;

export type ExecutionAgentRespondDecision = Readonly<
  ExecutionAgentDecisionPresentation & {
    action: "respond";
  }
>;

export type ExecutionAgentOpenCapabilityScopeDecision = Readonly<
  ExecutionAgentDecisionPresentation & {
    action: "open_capability_scope";
    catalogGroupIds: readonly string[];
  }
>;

export type ExecutionAgentExtendCapabilityScopeDecision = Readonly<
  ExecutionAgentDecisionPresentation & {
    action: "extend_capability_scope";
    catalogGroupIds: readonly string[];
  }
>;

export type ExecutionAgentBlockedDecision = Readonly<
  ExecutionAgentDecisionPresentation & {
    action: "blocked";
    response: string;
  }
>;

export type ExecutionAgentCapabilityInvocation = Readonly<{
  capabilityId: string;
  /** Client-facing presentation metadata; never execution input. */
  intent: string;
  selectionControls?: CapabilityControls;
  /** Present only when selection mechanically satisfies the full schema. */
  controls?: CapabilityControls;
}>;

export type ExecutionAgentInvokeCapabilityDecision = Readonly<
  ExecutionAgentDecisionPresentation &
    ExecutionAgentCapabilityInvocation & {
      action: "invoke_capability";
      workingDirectory?: string;
    }
>;

export type ExecutionAgentInvokeCapabilitiesDecision = Readonly<
  ExecutionAgentDecisionPresentation & {
    action: "invoke_capabilities";
    invocations: readonly ExecutionAgentCapabilityInvocation[];
    workingDirectory?: string;
  }
>;

export type ExecutionAgentInvokePlannerDecision = Readonly<
  ExecutionAgentDecisionPresentation & {
    action: "invoke_planner";
    objective: string;
  }
>;

export type ExecutionAgentInvokeAuditorDecision = Readonly<
  ExecutionAgentDecisionPresentation & {
    action: "invoke_auditor";
    criterionIds: readonly string[];
  }
>;

export type ExecutionAgentDecision =
  | ExecutionAgentOpenCapabilityScopeDecision
  | ExecutionAgentExtendCapabilityScopeDecision
  | ExecutionAgentRespondDecision
  | ExecutionAgentBlockedDecision
  | ExecutionAgentInvokeCapabilityDecision
  | ExecutionAgentInvokeCapabilitiesDecision
  | ExecutionAgentInvokePlannerDecision
  | ExecutionAgentInvokeAuditorDecision;

/** Runtime-only transition emitted when refinement declines an accepted selection. */
export type ExecutionAgentReconsiderCapabilitySelectionDecision = Readonly<{
  action: "reconsider_capability_selection";
  selection: RoleCapabilitySelectionProjection;
  acknowledgement?: undefined;
  title?: undefined;
}>;

export type ExecutionAgentResolvedDecision =
  | ExecutionAgentDecision
  | ExecutionAgentReconsiderCapabilitySelectionDecision;

export type ExecutionAgentDecisionOutcome = Readonly<{
  decision: ExecutionAgentResolvedDecision;
  steeringVersion: number;
}>;

export type ExecutionAgentDecisionValidationStage =
  | "json_envelope"
  | "domain_parser";

export type ExecutionAgentDecisionValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type ExecutionAgentDecisionParseResult =
  | Readonly<{ ok: true; decision: ExecutionAgentDecision }>
  | Readonly<{
      ok: false;
      stage: ExecutionAgentDecisionValidationStage;
      issues: readonly ExecutionAgentDecisionValidationIssue[];
    }>;

export type ExecutionAgentDecisionContractOptions = Readonly<{
  capabilities?: readonly CapabilityDescriptor[];
  capabilityCatalogGroupIds?: readonly string[];
  activeCapabilityCatalogGroupIds?: readonly string[] | null;
  maxBatchCapabilityExecutions?: number;
  includeAcknowledgement?: boolean;
  includeTitle?: boolean;
  allowRespond?: boolean;
  allowPlanner?: boolean;
  allowAuditor?: boolean;
  availableAuditCriterionIds?: readonly string[];
  includeWorkingDirectory?: boolean;
}>;
