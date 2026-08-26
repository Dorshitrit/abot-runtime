import type { ModelStep } from "../../shared/model-steps.js";
import type { RequestToolResultsView } from "../context/request-tool-results.js";
import type {
  ExecutionPolicyAuthoritySnapshot,
  RoleCallChildReturnCommit,
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
  RoleCallWorkerCapabilityScope,
  RoleCapabilitySelectionProjection,
  RoleChildReturnContext,
} from "../orchestration/role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../orchestration/roles.js";
import type { RoleExecutorRegistry } from "../orchestration/role-executors/index.js";
import type {
  WorkerCapabilityCatalogGroup,
  WorkerCapabilityControls,
} from "../orchestration/worker-capabilities/index.js";
import type { RequestRoleExecutionHandoff } from "./result.js";

export type RootContractCallIdentity = Readonly<{
  rootCallId: string;
  callId: string;
  parentCallId: string | null;
  depth: number;
  invocationAttempt: number;
}>;

export type RootContractDecision =
  | Readonly<{
      action: "respond";
      acknowledgement?: string;
      title?: string;
    }>
  | Readonly<{
      action: "invoke_role";
      roleId: RuntimeDelegateRoleId;
      objective: string;
      acknowledgement?: string;
      title?: string;
      workingDirectory?: string;
      workerCapabilityScope?: RoleCallWorkerCapabilityScope;
    }>
  | Readonly<{
      action: "update_capability_scope";
      mode: "open" | "extend";
      catalogGroupIds: readonly string[];
      acknowledgement?: string;
      title?: string;
    }>
  | Readonly<{
      action: "invoke_capability";
      capabilityId: string;
      intent: string;
      controls: WorkerCapabilityControls;
      workingDirectory?: string;
      acknowledgement?: string;
      title?: string;
    }>
  | Readonly<{
      action: "invoke_capabilities";
      invocations: readonly Readonly<{
        capabilityId: string;
        intent: string;
        controls: WorkerCapabilityControls;
      }>[];
      workingDirectory?: string;
      acknowledgement?: string;
      title?: string;
    }>
  | Readonly<{
      action: "blocked";
      response: string;
      acknowledgement?: string;
      title?: string;
    }>
  | Readonly<{
      action: "reconsider_capability_selection";
      selection: RoleCapabilitySelectionProjection;
      acknowledgement?: undefined;
      title?: undefined;
    }>;

export type RootContractDecisionOutcome = Readonly<{
  decision: RootContractDecision;
  steeringVersion: number;
}>;

export type RootContractAdapter<TRequest> = Readonly<{
  contractId: string;
  decisionModelStep: ModelStep;
  responseModelStep: ModelStep;
  /** Preserve legacy Supervisor timing unless a contract opts into sealed presentation. */
  deferRespondPresentation?: boolean;
  projectCallIdentity(head: RoleCallLedgerHead): RootContractCallIdentity;
  projectResume(
    ledger: RoleCallLedger,
    commit: RoleCallChildReturnCommit,
  ): RoleChildReturnContext;
  decide(
    request: TRequest,
    options: Readonly<{
      head: RoleCallLedgerHead;
      callFrame: RoleCallFrame;
      call: RootContractCallIdentity;
      toolResults: RequestToolResultsView;
      includeAcknowledgement: boolean;
      includeTitle: boolean;
      allowedRoleIds: readonly RuntimeDelegateRoleId[];
      availableWorkerCapabilityCatalog: readonly WorkerCapabilityCatalogGroup[];
      resume?: RoleChildReturnContext;
    }>,
  ): Promise<RootContractDecisionOutcome>;
  authorResponse(
    request: TRequest,
    options: Readonly<{
      head: RoleCallLedgerHead;
      callFrame: RoleCallFrame;
      steeringVersion: number;
      call: RootContractCallIdentity;
      toolResults: RequestToolResultsView;
      resume?: RoleChildReturnContext;
    }>,
  ): Promise<string>;
}>;

export type CompiledExecutionPolicy<TRequest> = Readonly<{
  authority: ExecutionPolicyAuthoritySnapshot;
  rootContract: RootContractAdapter<TRequest>;
  roleExecutors: RoleExecutorRegistry<TRequest, RequestRoleExecutionHandoff>;
}>;
