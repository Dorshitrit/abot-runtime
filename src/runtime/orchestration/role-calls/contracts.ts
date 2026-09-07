import type {
  CanonicalStateHead,
  CanonicalStateHeadTransactionFailureCode,
} from "../state-head.js";
import type { CapabilityAdapterResult } from "../capability-adapters/result.js";
import type { RuntimeDelegateRoleId, RuntimeRoleId } from "../roles.js";
import type {
  RoleOperationFingerprint,
  RoleOperationOutcomeFingerprint,
  RoleOperationSupervisionState,
} from "./operation-supervision.js";
import type {
  RoleCapabilitySelectionSupervisionStage,
  RoleCapabilitySelectionSupervisionState,
  RoleCapabilitySelectionSupervisionTrigger,
} from "./capability-selection-supervision.js";
import type { RoleCapabilitySelectionReconsiderationCause } from "./reconsideration-cause.js";
import type { RoleCallResultReceipt } from "./result-receipt.js";
import type { RoleMemoryRecall, RoleMemoryRecallCommand, RoleMemoryRecallCommitEffect, RoleMemoryRecallTransactions } from "./memory-recall-contract.js";

export const ROLE_CALL_LEDGER_CONTRACT_VERSION = 18;
export const ROLE_CALL_LEDGER_HEAD_KIND =
  "runtime_role_call_ledger_v18" as const;
export const ROLE_CALL_OBJECTIVE_MAX_LENGTH = 8_192;
export const ROLE_CALL_RESULT_MAX_LENGTH = 8_192;
export const ROLE_CALL_RESPONSE_MAX_LENGTH = 65_536;
export const ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH = 256;
export const ROLE_CAPABILITY_ID_MAX_LENGTH = 128;
export const ROLE_CAPABILITY_EXECUTION_LIMIT_MAX = 192;
export const ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX = 64;
export const ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH = 4_096;
export const ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH = 32_768;
export const ROLE_CAPABILITY_INVOCATION_INTENT_MAX_LENGTH =
  ROLE_CALL_OBJECTIVE_MAX_LENGTH;
/**
 * Covers the complete existing controls envelope, including worst-case JSON
 * escaping, without narrowing any previously accepted Worker invocation.
 */
export const ROLE_CAPABILITY_INVOCATION_CONTROLS_JSON_MAX_LENGTH =
  32 * 1_024 * 1_024;
export const ROLE_CAPABILITY_SELECTION_INVOCATION_LIMIT_MAX = 64;

export function isRoleCapabilityId(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= ROLE_CAPABILITY_ID_MAX_LENGTH &&
    /^[a-z][a-z0-9._-]*$/.test(input)
  );
}

export type ExecutionPolicyCapabilityAuthority = "root" | RuntimeDelegateRoleId;
export type RoleCallTerminalTextMode = "normalized" | "exact";

export type ExecutionPolicyAuthoritySnapshot = Readonly<{
  id: string;
  version: number;
  definitionHash: string;
  rootContractId: string;
  availableSubordinateContractIds: readonly RuntimeDelegateRoleId[];
  capabilityAuthorities: readonly ExecutionPolicyCapabilityAuthority[];
  /** Omission preserves the legacy normalized terminal-text contract. */
  terminalTextMode?: RoleCallTerminalTextMode;
}>;

export const SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT: ExecutionPolicyAuthoritySnapshot =
  Object.freeze({
    id: "supervisor-worker-v1",
    version: 2,
    definitionHash:
      "sha256:2ee79cee6dbb27ffaeb59f84c4c838cf9d16a965ca4f07e7d638e8589868e036",
    rootContractId: "supervisor",
    availableSubordinateContractIds: Object.freeze([
      "planner",
      "worker",
      "reviewer",
    ] as const),
    capabilityAuthorities: Object.freeze(["worker"] as const),
  });

export type RoleCallPolicy = Readonly<{
  authority: ExecutionPolicyAuthoritySnapshot;
  limits: Readonly<{
    maxDepth: number;
    maxCalls: number;
    maxCapabilityExecutions: number;
    maxObjectiveChars: number;
    maxResultChars: number;
    maxResponseChars: number;
  }>;
}>;

export type RoleCallPolicyInput = Readonly<{
  /** Legacy direct fixtures may omit authority; canonical heads never do. */
  authority?: ExecutionPolicyAuthoritySnapshot;
  limits: RoleCallPolicy["limits"];
}>;

export type RoleCallFrameStatus =
  | "active"
  | "waiting_for_child"
  | "waiting_for_capability"
  | "waiting_for_memory"
  | "completed";

export type RoleCallWorkerCapabilityScope = Readonly<{
  catalogGroupIds: readonly string[];
}>;

export type RoleCapabilitySelectionProjection = Readonly<{
  action: "invoke_capability" | "invoke_capabilities";
  invocations: readonly Readonly<{
    capabilityId: string;
    intent: string;
    selectionControlsJson: string;
  }>[];
  workingDirectory: string | null;
  activeCapabilityCatalogGroupIds: readonly string[];
}>;

export type RoleCapabilitySelectionReconsideration = Readonly<{
  invocationAttempt: number;
  steeringVersion: number;
  fingerprint: string;
  selection: RoleCapabilitySelectionProjection;
  cause: RoleCapabilitySelectionReconsiderationCause;
}>;

export type RoleCallFrame = Readonly<{
  callId: string;
  parentCallId: string | null;
  roleId: RuntimeRoleId;
  depth: number;
  objective: string | null;
  workerCapabilityScope?: RoleCallWorkerCapabilityScope;
  workingDirectory?: string;
  dependencyResultRefs: readonly string[];
  status: RoleCallFrameStatus;
  childCallIds: readonly string[];
  activationCount: number;
  resultRef: string | null;
  /** Omitted unless the immediately preceding activation reconsidered a selection. */
  lastCapabilitySelectionReconsideration?: RoleCapabilitySelectionReconsideration;
}>;

export type RoleCallResult = Readonly<{
  resultRef: string;
  producerCallId: string;
  roleId: RuntimeDelegateRoleId;
  outcome: "completed" | "failed";
  summary: string;
  receipt?: RoleCallResultReceipt;
}>;

export type RoleCallPlanItemStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "blocked";

export type RoleCallPlanProposal = Readonly<{
  summary: string;
  items: RoleCallPlanProposedItems;
}>;

export type RoleCallPlanProposedItems = readonly Readonly<{
  title: string;
  objective: string;
}>[];

export type RoleCallPlanExtensionProposal = Readonly<{
  items: RoleCallPlanProposedItems;
}>;

export type RoleCallPlanBinding =
  | Readonly<{
      mode: "declare";
      plan: RoleCallPlanProposal;
      selectedItemIndexes: readonly number[];
    }>
  | Readonly<{
      mode: "select";
      itemIds: readonly string[];
    }>
  | Readonly<{
      mode: "extend";
      extension: RoleCallPlanExtensionProposal;
      selectedItemIndexes: readonly number[];
    }>;

export type RoleCallPlanDefinition = Readonly<{
  planId: string;
  plannerCallId: string;
  version: number;
  summary: string;
  items: readonly Readonly<{
    itemId: string;
    title: string;
    objective: string;
  }>[];
}>;

export type RoleCallPlanItemState = Readonly<{
  itemId: string;
  status: RoleCallPlanItemStatus;
  childCallId: string | null;
}>;

export type RoleCallPlanState = Readonly<{
  definition: RoleCallPlanDefinition;
  itemStates: readonly RoleCallPlanItemState[];
}>;

export type RoleCapabilityEffect = "observation" | "mutation";
export type RoleCapabilityDeclaredEffect = RoleCapabilityEffect | "mixed";
export type RoleCapabilityObservedEffect =
  | "none"
  | RoleCapabilityEffect
  | "indeterminate";
export type RoleCapabilityExecutionOutcome = "succeeded" | "failed";
export type RoleCapabilityExecutionStatus = "running" | "settled";

export type RoleCapabilityResultReference = Readonly<{
  kind: "tool_target";
  target: string;
}>;

export type RoleCapabilityExecution = Readonly<{
  executionId: string;
  callId: string;
  invocationAttempt: number;
  capabilityId: string;
  declaredEffect: RoleCapabilityDeclaredEffect;
  intent: string;
  controlsJson: string;
  actionFingerprint?: RoleOperationFingerprint;
  status: RoleCapabilityExecutionStatus;
  outcome: RoleCapabilityExecutionOutcome | null;
  outcomeFingerprint: RoleOperationOutcomeFingerprint | null;
  observedEffect: RoleCapabilityObservedEffect | null;
  summary: string | null;
  referenceData?: string;
  references?: readonly RoleCapabilityResultReference[];
  /** Canonical adapter/plugin envelope; required for every settled execution. */
  exactResult?: CapabilityAdapterResult;
}>;

export type RoleCallState = Readonly<{
  contractVersion: typeof ROLE_CALL_LEDGER_CONTRACT_VERSION;
  requestId: string;
  phase: "empty" | "running" | "completed";
  rootCallId: string | null;
  activeCallId: string | null;
  callSequence: number;
  resultSequence: number;
  capabilityExecutionSequence: number;
  calls: readonly RoleCallFrame[];
  results: readonly RoleCallResult[];
  plans: readonly RoleCallPlanState[];
  capabilityExecutions: readonly RoleCapabilityExecution[];
  memoryRecalls: readonly RoleMemoryRecall[];
  operationSupervision: RoleOperationSupervisionState;
  capabilitySelectionSupervision: RoleCapabilitySelectionSupervisionState;
  rootResponse: string | null;
}>;

export type RoleCallLedgerHead = CanonicalStateHead<
  typeof ROLE_CALL_LEDGER_HEAD_KIND,
  RoleCallState,
  RoleCallPolicy
>;

export type CreateRootRoleCallCommand = Readonly<{
  authority: "runtime";
  type: "create_root";
}>;

export type CompleteRootResponseCommand = Readonly<{
  authority: "supervisor";
  type: "complete_root_response";
  callId: string;
  response: string;
}>;

export type OpenChildRoleCallCommand = Readonly<{
  authority: "active_role";
  type: "open_child";
  callerCallId: string;
  roleId: RuntimeDelegateRoleId;
  objective: string;
  workerCapabilityScope?: RoleCallWorkerCapabilityScope;
  workingDirectory?: string;
  dependencyResultRefs?: readonly string[];
  plannerPlan?: RoleCallPlanBinding;
}>;

export type ReturnChildRoleCallCommand = Readonly<{
  authority: "runtime";
  type: "return_child";
  callerCallId: string;
  childCallId: string;
  outcome: "completed" | "failed";
  summary: string;
  receipt?: RoleCallResultReceipt;
}>;

export type BeginRoleCapabilityExecutionCommand = Readonly<{
  authority: "active_role";
  type: "begin_capability_execution";
  callId: string;
  invocationAttempt: number;
  capabilityId: string;
  declaredEffect: RoleCapabilityDeclaredEffect;
  intent: string;
  controlsJson: string;
  actionFingerprint?: RoleOperationFingerprint;
}>;

export type SettleRoleCapabilityExecutionCommand = Readonly<{
  authority: "runtime";
  type: "settle_capability_execution";
  callId: string;
  executionId: string;
  outcome: RoleCapabilityExecutionOutcome;
  outcomeFingerprint?: RoleOperationOutcomeFingerprint;
  observedEffect: RoleCapabilityObservedEffect;
  summary: string;
  referenceData?: string;
  references?: readonly RoleCapabilityResultReference[];
  exactResult: CapabilityAdapterResult;
}>;

export type RoleCapabilityObservationBatchEntry = Readonly<{
  capabilityId: string;
  declaredEffect: "observation";
  intent: string;
  controlsJson: string;
  actionFingerprint?: RoleOperationFingerprint;
}>;

export type BeginRoleCapabilityBatchCommand = Readonly<{
  authority: "active_role";
  type: "begin_capability_batch";
  callId: string;
  invocationAttempt: number;
  entries: readonly RoleCapabilityObservationBatchEntry[];
}>;

export type RoleCapabilityBatchSettlement = Readonly<{
  executionId: string;
  outcome: RoleCapabilityExecutionOutcome;
  outcomeFingerprint?: RoleOperationOutcomeFingerprint;
  observedEffect: RoleCapabilityObservedEffect;
  summary: string;
  referenceData?: string;
  references?: readonly RoleCapabilityResultReference[];
  exactResult: CapabilityAdapterResult;
}>;

export type SettleRoleCapabilityBatchCommand = Readonly<{
  authority: "runtime";
  type: "settle_capability_batch";
  callId: string;
  settlements: readonly RoleCapabilityBatchSettlement[];
}>;

export type UpdateRoleCapabilityScopeCommand = Readonly<{
  authority: "active_role";
  type: "update_capability_scope";
  callId: string;
  invocationAttempt: number;
  mode: "open" | "extend";
  catalogGroupIds: readonly string[];
}>;

export type EstablishRoleCallWorkingDirectoryCommand = Readonly<{
  authority: "active_role";
  type: "establish_working_directory";
  callId: string;
  invocationAttempt: number;
  workingDirectory: string;
}>;

export type ReconsiderRoleCapabilitySelectionCommand = Readonly<{
  authority: "active_role";
  type: "reconsider_capability_selection";
  callId: string;
  invocationAttempt: number;
  steeringVersion: number;
  selection: RoleCapabilitySelectionProjection;
  cause: RoleCapabilitySelectionReconsiderationCause;
}>;

export type RoleCallLedgerCommand =
  | RoleMemoryRecallCommand
  | CreateRootRoleCallCommand
  | CompleteRootResponseCommand
  | OpenChildRoleCallCommand
  | ReturnChildRoleCallCommand
  | BeginRoleCapabilityExecutionCommand
  | SettleRoleCapabilityExecutionCommand
  | BeginRoleCapabilityBatchCommand
  | SettleRoleCapabilityBatchCommand
  | UpdateRoleCapabilityScopeCommand
  | EstablishRoleCallWorkingDirectoryCommand
  | ReconsiderRoleCapabilitySelectionCommand;

export type RoleCallCommitEffect =
  | RoleMemoryRecallCommitEffect
  | Readonly<{ type: "root_created"; callId: string }>
  | Readonly<{
      type: "root_response_committed";
      callId: string;
    }>
  | Readonly<{
      type: "child_opened";
      callerCallId: string;
      childCallId: string;
      planItemIds?: readonly string[];
    }>
  | Readonly<{
      type: "child_returned";
      callerCallId: string;
      childCallId: string;
      resultRef: string;
      planItemIds?: readonly string[];
    }>
  | Readonly<{
      type: "capability_execution_begun";
      callId: string;
      executionId: string;
    }>
  | Readonly<{
      type: "operation_supervision_intervened";
      callId: string;
      invocationAttempt: number;
      capabilityId: string;
      actionFingerprint: RoleOperationFingerprint;
      priorOutcome: RoleCapabilityExecutionOutcome;
      outcomeFingerprint: RoleOperationOutcomeFingerprint;
      originExecutionId: string;
      matchingOutcomeCount: 2;
      interventionCount: 1;
    }>
  | Readonly<{
      type: "capability_execution_settled";
      callId: string;
      executionId: string;
    }>
  | Readonly<{
      type: "capability_batch_begun";
      callId: string;
      executionIds: readonly string[];
    }>
  | Readonly<{
      type: "capability_batch_settled";
      callId: string;
      executionIds: readonly string[];
    }>
  | Readonly<{
      type: "capability_scope_updated";
      callId: string;
      mode: "open" | "extend";
      catalogGroupIds: readonly string[];
    }>
  | Readonly<{
      type: "working_directory_established";
      callId: string;
    }>
  | Readonly<{
      type: "capability_selection_reconsidered";
      callId: string;
      invocationAttempt: number;
      fingerprint: string;
      supervisionFingerprint: string;
      supervisionStage: RoleCapabilitySelectionSupervisionStage;
      supervisionTrigger: RoleCapabilitySelectionSupervisionTrigger;
      matchingSelectionCount: number;
      totalReconsiderationCount: number;
    }>;

export type RoleCallValidationIssue = Readonly<{
  code: string;
  path: string;
}>;

export type RoleCallTransitionRejectionCode =
  | "invalid_current_state"
  | "invalid_policy"
  | "invalid_command"
  | "root_already_created"
  | "root_missing"
  | "caller_not_active"
  | "root_response_not_allowed"
  | "supervisor_child_forbidden"
  | "child_role_not_authorized"
  | "child_dependency_invalid"
  | "planner_plan_binding_invalid"
  | "planner_plan_already_declared"
  | "planner_plan_missing"
  | "planner_plan_item_unavailable"
  | "planner_plan_incomplete"
  | "depth_limit_exceeded"
  | "call_limit_exceeded"
  | "child_return_mismatch"
  | "capability_caller_invalid"
  | "capability_invocation_mismatch"
  | "capability_execution_limit_exceeded"
  | "capability_execution_mismatch"
  | "capability_scope_update_invalid"
  | "working_directory_establishment_invalid"
  | "capability_selection_reconsideration_invalid"
  | "capability_selection_supervision_limit_exceeded"
  | "operation_supervision_limit_exceeded"
  | "memory_recall_caller_invalid"
  | "memory_recall_invocation_mismatch"
  | "memory_recall_settlement_mismatch"
  | "role_activation_limit_exceeded";

export type RoleCallTransitionResult =
  | Readonly<{
      ok: true;
      state: RoleCallState;
      effect: RoleCallCommitEffect;
    }>
  | Readonly<{
      ok: false;
      state: RoleCallState;
      code: RoleCallTransitionRejectionCode;
      issues?: readonly RoleCallValidationIssue[];
    }>;

export type RoleCallLedgerRejectionCode =
  | RoleCallTransitionRejectionCode
  | Extract<
      CanonicalStateHeadTransactionFailureCode,
      "invalid_expected_head" | "stale_head"
    >
  | "state_head_rejected";

export type RoleCallLedgerCommitResult =
  | Readonly<{
      ok: true;
      status: "committed";
      previousHead: RoleCallLedgerHead;
      head: RoleCallLedgerHead;
      effect: RoleCallCommitEffect;
    }>
  | Readonly<{
      ok: false;
      status: "committed_with_fault";
      code: "after_commit_fault" | "transaction_callback_fault";
      previousHead: RoleCallLedgerHead;
      head: RoleCallLedgerHead;
      effect: RoleCallCommitEffect;
    }>
  | Readonly<{
      ok: false;
      status: "rejected";
      code: RoleCallLedgerRejectionCode;
      head: RoleCallLedgerHead;
      issues?: readonly RoleCallValidationIssue[];
    }>;

export type RoleCallLedgerCommit = Extract<
  RoleCallLedgerCommitResult,
  { status: "committed" }
>;

export type RoleCallLedgerCommitObserver = (
  commit: RoleCallLedgerCommit,
) => void;

export type RoleCallLedgerCommitObservers = Readonly<{
  /** Registers one trusted synchronous observer for every canonical commit. */
  subscribe(observer: RoleCallLedgerCommitObserver): void;
}>;

export type RoleCallTransactionInput<TCommand extends RoleCallLedgerCommand> =
  Readonly<{ expectedHead: unknown } & Omit<TCommand, "authority" | "type">>;

/** Transient root fence evaluated after ledger-head admission and before transition. */
export type RoleCallCapabilityExecutionAdmission = Readonly<{
  isCurrent(): boolean;
}>;

export type BeginRoleCapabilityExecutionTransactionInput =
  RoleCallTransactionInput<BeginRoleCapabilityExecutionCommand> &
    Readonly<{
      admission?: RoleCallCapabilityExecutionAdmission;
    }>;

export type BeginRoleCapabilityBatchTransactionInput =
  RoleCallTransactionInput<BeginRoleCapabilityBatchCommand> &
    Readonly<{
      admission?: RoleCallCapabilityExecutionAdmission;
    }>;

export type RoleCallTransactionSuccess<
  TEffectType extends RoleCallCommitEffect["type"],
> = Readonly<{
  ok: true;
  commit: RoleCallLedgerCommit &
    Readonly<{
      effect: Extract<RoleCallCommitEffect, { type: TEffectType }>;
    }>;
}>;

export type RoleCallTransactionFailure<TTransitionIssueCode extends string> =
  Readonly<{
    ok: false;
    issueCode:
      | Extract<RoleCallLedgerCommitResult, { ok: false }>["code"]
      | TTransitionIssueCode;
    commit: RoleCallLedgerCommitResult;
  }>;

export type RoleCallTransactionResult<
  TEffectType extends RoleCallCommitEffect["type"],
  TTransitionIssueCode extends string,
> =
  | RoleCallTransactionSuccess<TEffectType>
  | RoleCallTransactionFailure<TTransitionIssueCode>;

export type RoleCallTransactions = RoleMemoryRecallTransactions & Readonly<{
  createRoot(
    input: Readonly<{ expectedHead: unknown }>,
  ): Promise<
    RoleCallTransactionResult<"root_created", "root_create_transition_invalid">
  >;
  completeRootResponse(
    input: RoleCallTransactionInput<CompleteRootResponseCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "root_response_committed",
      "root_response_transition_invalid"
    >
  >;
  openChild(
    input: RoleCallTransactionInput<OpenChildRoleCallCommand>,
  ): Promise<
    RoleCallTransactionResult<"child_opened", "child_open_transition_invalid">
  >;
  returnChild(
    input: RoleCallTransactionInput<ReturnChildRoleCallCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "child_returned",
      "child_return_transition_invalid"
    >
  >;
  beginCapabilityExecution(
    input: BeginRoleCapabilityExecutionTransactionInput,
  ): Promise<
    RoleCallTransactionResult<
      "capability_execution_begun" | "operation_supervision_intervened",
      "commit_effect_invalid"
    >
  >;
  settleCapabilityExecution(
    input: RoleCallTransactionInput<SettleRoleCapabilityExecutionCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "capability_execution_settled",
      "commit_effect_invalid"
    >
  >;
  beginCapabilityBatch(
    input: BeginRoleCapabilityBatchTransactionInput,
  ): Promise<
    RoleCallTransactionResult<
      "capability_batch_begun" | "operation_supervision_intervened",
      "commit_effect_invalid"
    >
  >;
  settleCapabilityBatch(
    input: RoleCallTransactionInput<SettleRoleCapabilityBatchCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "capability_batch_settled",
      "commit_effect_invalid"
    >
  >;
  updateCapabilityScope(
    input: RoleCallTransactionInput<UpdateRoleCapabilityScopeCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "capability_scope_updated",
      "capability_scope_transition_invalid"
    >
  >;
  establishWorkingDirectory(
    input: RoleCallTransactionInput<EstablishRoleCallWorkingDirectoryCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "working_directory_established",
      "working_directory_transition_invalid"
    >
  >;
  reconsiderCapabilitySelection(
    input: RoleCallTransactionInput<ReconsiderRoleCapabilitySelectionCommand>,
  ): Promise<
    RoleCallTransactionResult<
      "capability_selection_reconsidered",
      "capability_selection_reconsideration_transition_invalid"
    >
  >;
}>;

export type RoleCallLedger = Readonly<{
  current(): RoleCallLedgerHead;
  commits: RoleCallLedgerCommitObservers;
  /** Factory ledgers own this facade; optional only for structural legacy fakes. */
  transactions?: RoleCallTransactions;
  apply(
    input: Readonly<{
      expectedHead: unknown;
      command: unknown;
      capabilityExecutionAdmission?: RoleCallCapabilityExecutionAdmission;
    }>,
  ): Promise<RoleCallLedgerCommitResult>;
}>;
