import type {
  ChatMessage,
  ModelGatewayJsonSchemaFormat,
} from "../../../../model-gateway/types.js";
import type { RequestExecutionSeed } from "../../../request/contracts.js";
import type { RequestContextProjection } from "../../../context/request-context-contracts.js";
import type { RequestToolResultsView } from "../../../context/request-tool-results.js";
import { buildSessionArtifactPathsMessage } from "../../../context/session-artifact-paths.js";
import type { ConfiguredStepInstructionMetadata } from "../../../config/runner/step-instructions.js";
import { resolveModelContextBudget } from "../../../model/model-context-budget.js";
import {
  projectRoleCallAssignmentScope,
  type RoleCallDependencyResult,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../../../orchestration/role-calls/index.js";
import {
  type WorkerCapabilityBinding,
  type WorkerCapabilityControls,
  type WorkerCapabilityDescriptor,
} from "../../../orchestration/worker-capabilities/index.js";
import type { WorkerCapabilityAffordance } from "../capability-affordances.js";
import type { WorkerCapabilityCatalogProjection } from "../capability-catalog.js";
import type { WorkerCapabilitySelectionRejection } from "../capability-selection-rejection.js";
import {
  projectWorkerDecisionCallIdentity,
  type WorkerDecision,
  type WorkerDecisionDiagnosticContext,
  type WorkerResultAuthorSource,
} from "../contracts.js";
import { projectWorkerCapabilityResumeContext } from "../ledger-projection.js";

export type WorkerDecisionInputRequest = Pick<
  RequestExecutionSeed,
  | "requestId"
  | "prompt"
  | "historyMessages"
  | "runnerConfig"
  | "agentMode"
  | "modelPreference"
  | "modelPolicy"
> &
  Partial<
    Pick<
      RequestExecutionSeed,
      | "onEvent"
      | "sessionArtifactPaths"
      | "temporalContext"
      | "contextCompactionStore"
    >
  >;

export type WorkerDecisionCapabilityBinding = Pick<
  WorkerCapabilityBinding<unknown>,
  "requestId" | "ledger" | "callId" | "invocationAttempt" | "capabilities"
>;

type WorkerDecisionCanonicalSource = Readonly<{
  ledger: RoleCallLedger;
  head: RoleCallLedgerHead;
}>;

export type WorkerDecisionCapabilitySource = WorkerDecisionCanonicalSource &
  Readonly<{
    binding: WorkerDecisionCapabilityBinding;
  }>;

export type WorkerDecisionCapabilityResumeSource =
  WorkerDecisionCanonicalSource &
    (
      | Readonly<{ executionId: string }>
      | Readonly<{ executionIds: readonly string[] }>
    );

export type WorkerSelectedCapabilityExecution = Readonly<{
  capabilityId: string;
  intent: string;
  selectionControls?: WorkerCapabilityControls;
  guidance: string;
}>;

export type WorkerSelectedCapabilityBatchExecution = Readonly<{
  invocations: readonly Readonly<{
    capabilityId: string;
    intent: string;
    selectionControls?: WorkerCapabilityControls;
    guidance: string;
  }>[];
}>;

export type WorkerPendingCapabilitySelection = Readonly<{
  capabilityId: string;
  intent: string;
  selectionControls?: WorkerCapabilityControls;
}>;

export type WorkerPendingCapabilityBatchSelection =
  readonly WorkerPendingCapabilitySelection[];

export type WorkerDecisionInputOptions = Readonly<{
  call: RoleCallFrame;
  requestToolResults: RequestToolResultsView;
  capabilitySource?: WorkerDecisionCapabilitySource;
  capabilityResume?: WorkerDecisionCapabilityResumeSource;
  selectedCapabilityExecution?: WorkerSelectedCapabilityExecution;
  selectedCapabilityBatchExecution?: WorkerSelectedCapabilityBatchExecution;
  capabilitySelectionRejection?: WorkerCapabilitySelectionRejection;
  requestToolResultsContextMessage?: ChatMessage;
  diagnostic?: WorkerDecisionDiagnosticContext;
}>;

export type PreparedWorkerCapabilitySelection = Readonly<{
  capabilities: readonly WorkerCapabilityDescriptor[];
  selectedCapabilityExecution?: WorkerSelectedCapabilityExecution;
  selectedCapabilityBatchExecution?: WorkerSelectedCapabilityBatchExecution;
  pendingCapabilitySelection?: WorkerPendingCapabilitySelection;
  pendingCapabilityBatchSelection?: WorkerPendingCapabilityBatchSelection;
  executionPending: boolean;
}>;

export type PreparedWorkerCanonicalState = Readonly<{
  canonicalSource:
    | WorkerDecisionCapabilitySource
    | WorkerDecisionCapabilityResumeSource
    | undefined;
  assignmentScope:
    | ReturnType<typeof projectRoleCallAssignmentScope>
    | undefined;
  dependencyResults: readonly RoleCallDependencyResult[];
  resume: ReturnType<typeof projectWorkerCapabilityResumeContext> | undefined;
}>;

export type PreparedWorkerDecisionContract = Readonly<{
  availableCapabilityIds: readonly string[];
  availableCapabilityAffordances: readonly WorkerCapabilityAffordance[];
  capabilitiesAvailable: boolean;
  sessionArtifactPathSelectionDeferred: boolean;
  capabilitySelectionRejection: WorkerCapabilitySelectionRejection | undefined;
  selectionCatalog: WorkerCapabilityCatalogProjection;
  capabilityCatalogProjection: WorkerCapabilityCatalogProjection["kind"];
  capabilityPromptPayload: WorkerCapabilityCatalogProjection["promptPayload"];
  allowedActions: readonly WorkerDecision["action"][];
  maxBatchCapabilityExecutions: number;
  format: ModelGatewayJsonSchemaFormat;
}>;

export type PreparedWorkerDecisionSession = Readonly<{
  request: WorkerDecisionInputRequest;
  options: WorkerDecisionInputOptions;
  callIdentity: ReturnType<typeof projectWorkerDecisionCallIdentity>;
  diagnostic: WorkerDecisionDiagnosticContext;
  objective: string;
  eligibleSessionArtifactPaths: readonly string[];
  sessionArtifactPathAvailableCount: number;
  capabilitySelection: PreparedWorkerCapabilitySelection;
  canonicalState: PreparedWorkerCanonicalState;
  contract: PreparedWorkerDecisionContract;
}>;

export type PreparedWorkerReferenceContext = Readonly<{
  requestToolResultsMessage: ChatMessage | undefined;
  resultAuthorSource: WorkerResultAuthorSource;
  baseReferenceMessages: readonly ChatMessage[];
  continuationMessages: readonly ChatMessage[];
}>;

export type PreparedWorkerPromptContext = Readonly<{
  budget: ReturnType<typeof resolveModelContextBudget>;
  baseInstructions: string;
  instructions: string;
  configuredInstructionMetadata: ConfiguredStepInstructionMetadata;
  prompt: string;
}>;

export type ProjectedWorkerDecisionContext = Readonly<{
  sessionArtifactPathProjection: ReturnType<
    typeof buildSessionArtifactPathsMessage
  >;
  referenceMessages: readonly ChatMessage[];
  context: RequestContextProjection;
}>;

export type PreparedWorkerDecisionAssembly = Readonly<{
  references: PreparedWorkerReferenceContext;
  prompt: PreparedWorkerPromptContext;
  projection: ProjectedWorkerDecisionContext;
}>;
