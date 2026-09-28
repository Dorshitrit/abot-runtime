import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import type {
  RoleApprovalContinuation,
  RoleApprovalWait,
} from "../orchestration/role-executors/approval-continuation.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import type { RequestRunnerResult } from "./result.js";
import type {
  RootContractCallIdentity,
  RootContractDecision,
} from "./root-contract.js";
import type { RootObservationHandoff } from "./root-observation-handoff.js";
import type { SupervisorRootFailureStage } from "./supervisor-root-execution-diagnostics.js";

export type RootActivation = Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  callIdentity: RootContractCallIdentity;
}>;
export type RootDecisionActivation = RootActivation &
  Readonly<{
    decision: RootContractDecision;
    decisionSteeringVersion: number;
    requiresFreshPresentation: boolean;
    deferPresentation: boolean;
  }>;
export type RootActivationAttempt = {
  failureStage: SupervisorRootFailureStage;
  head?: RoleCallLedgerHead;
  call?: RoleCallFrame;
  publishDeferredTitle?: () => Promise<void>;
};
export type RootLoopControl =
  | Readonly<{ kind: "continue" }>
  | Readonly<{ kind: "complete"; result: RequestRunnerResult }>
  | RoleApprovalWait;
export type RootContinuationPresentation = Readonly<{
  acknowledgementPublished: boolean;
  titlePublished: boolean;
  observationHandoff?: RootObservationHandoff;
}>;
export type RootApprovalWait = RoleApprovalWait &
  Readonly<{ root: RootContinuationPresentation }>;
export type RootExecutionInput = Readonly<{
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
  durableApproval?: boolean;
  continuation?: RoleApprovalContinuation;
  presentation?: RootContinuationPresentation;
}>;
