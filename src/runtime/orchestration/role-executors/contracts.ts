import type {
  RoleCallChildReturnCommit,
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
  RoleCallOperationSupervisionInterventionCommit,
  RoleCallPlanBinding,
  RoleCallResultReceipt,
  RoleCallWorkerCapabilityScope,
} from "../role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../roles.js";
import type {
  RoleApprovalContinuation,
  RoleApprovalWait,
} from "./approval-continuation.js";

export type RoleExecutionOutcome = "completed" | "failed";

export type RoleExecutionResult<TValue = unknown> = Readonly<{
  kind: "terminal";
  outcome: RoleExecutionOutcome;
  summary: string;
  receipt?: RoleCallResultReceipt;
  value?: TValue;
}>;

export type RoleChildInvocationResult<TValue = unknown> = Readonly<{
  execution: RoleExecutionResult<TValue>;
  returnCommit: RoleCallChildReturnCommit;
}>;

export type RoleCapabilityExecutionContinuationReference = Readonly<{
  kind: "capability_execution";
  executionId: string;
}>;

export type RoleCapabilityBatchExecutionContinuationReference = Readonly<{
  kind: "capability_batch_execution";
  executionIds: readonly string[];
}>;

export type RoleOperationSupervisionInterventionContinuation = Readonly<{
  kind: "operation_supervision_intervention";
  commit: RoleCallOperationSupervisionInterventionCommit;
}>;

export type RoleChildContinuationReference = Readonly<{
  kind: "role_child";
  commit: RoleCallChildReturnCommit;
}>;

export type RoleExecutionContinuationReference =
  | RoleCapabilityExecutionContinuationReference
  | RoleCapabilityBatchExecutionContinuationReference
  | RoleOperationSupervisionInterventionContinuation
  | RoleChildContinuationReference;

export type RoleExecutionContinuation = Readonly<{
  kind: "continue";
  continuation:
    | RoleCapabilityExecutionContinuationReference
    | RoleCapabilityBatchExecutionContinuationReference
    | RoleOperationSupervisionInterventionContinuation;
}>;

export type RoleExecutionChildInvocation = Readonly<{
  kind: "invoke_role";
  roleId: RuntimeDelegateRoleId;
  objective: string;
  workerCapabilityScope?: RoleCallWorkerCapabilityScope;
  workingDirectory?: string;
  plannerPlan?: RoleCallPlanBinding;
}>;

export type RoleExecutorActivationResult<TValue = unknown> =
  | RoleExecutionResult<TValue>
  | RoleApprovalWait
  | RoleExecutionContinuation
  | RoleExecutionChildInvocation;

export type RoleExecutorInput<TContext> = Readonly<{
  context: TContext;
  call: RoleCallFrame;
  ledger: RoleCallLedger;
  availableChildRoleIds: readonly RuntimeDelegateRoleId[];
  continuation?: RoleExecutionContinuationReference;
}>;

export type RoleExecutor<TContext, TValue = unknown> = Readonly<{
  roleId: RuntimeDelegateRoleId;
  execute(
    input: RoleExecutorInput<TContext>,
  ): Promise<RoleExecutorActivationResult<TValue>>;
}>;

export type RoleChildInvocationInput<TContext> = Readonly<{
  requestId: string;
  context: TContext;
  callerCall: RoleCallFrame;
  ledger: RoleCallLedger;
  expectedHead: RoleCallLedgerHead;
  roleId: RuntimeDelegateRoleId;
  objective: string;
  workerCapabilityScope?: RoleCallWorkerCapabilityScope;
  workingDirectory?: string;
  plannerPlan?: RoleCallPlanBinding;
  turnCount: number;
  entered?: RoleApprovalContinuation;
  allowApprovalWait?: boolean;
}>;

export type RoleExecutionInput<TContext> = Readonly<{
  requestId: string;
  context: TContext;
  call: RoleCallFrame;
  ledger: RoleCallLedger;
  continuationState?: RoleApprovalContinuation;
  allowApprovalWait?: boolean;
}>;

export type RoleExecutorRegistry<TContext, TValue = unknown> = Readonly<{
  roleIds: readonly RuntimeDelegateRoleId[];
  invokeChild(
    input: RoleChildInvocationInput<TContext> & { allowApprovalWait: true },
  ): Promise<RoleChildInvocationResult<TValue> | RoleApprovalWait>;
  invokeChild(
    input: RoleChildInvocationInput<TContext> & { allowApprovalWait?: false },
  ): Promise<RoleChildInvocationResult<TValue>>;
  execute(
    input: RoleExecutionInput<TContext> & { allowApprovalWait: true },
  ): Promise<RoleExecutionResult<TValue> | RoleApprovalWait>;
  execute(
    input: RoleExecutionInput<TContext> & { allowApprovalWait?: false },
  ): Promise<RoleExecutionResult<TValue>>;
}>;
