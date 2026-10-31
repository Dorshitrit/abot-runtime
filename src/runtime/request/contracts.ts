import type { SessionRequestAdmissionClaim } from "./session-admission.js";
import type { RequestUserInteractions } from "../user-interactions/contracts.js";
import type { InformationBasketService } from "../information-basket/contracts.js";
import type { ModelReasoningPreference } from "../../shared/model-reasoning.js";
import type { KnowledgeSkillStore } from "../knowledge-skills/store.js";
import type { RequestToolResources } from "../capabilities/request-tool-resources.js";
import type { CapabilityApprovalGate } from "../orchestration/worker-capabilities/approval-contracts.js";
import type { RequestApprovalExecution } from "./approval-wait/snapshot.js";
import type {
  ModelGatewayAttachment,
  ModelGatewayPolicyConfig,
  ModelPreference,
} from "../../model-gateway/types.js";
import type { AgentMode } from "../../shared/types.js";
import type { ScheduleMessageReference } from "../../sessions/schedule-metadata.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import type { RuntimeThinkingTrace } from "../model/thinking-trace.js";
import type {
  EventSinkFactory,
  ModelGatewayClient,
  RuntimeConfig,
  ToolApprovalController,
  ToolPermissionMode,
  ToolRegistry,
} from "../ports.js";
import type { RequestRunnerConfig } from "../config/runner/contracts.js";
import type { RequestExecutionPolicySelection } from "../config/model-execution-policy.js";
import type { RequestHistoryMessage } from "../context/request-context-contracts.js";
import type { RequestContextCompactionStore } from "../context/semantic-compaction/index.js";
import type { SessionMemoryCompactorComposition } from "../context/super-compaction/history-routing.js";
import type { RequestTemporalContext } from "../context/request-temporal-context.js";
import type { RequestSessionStore } from "./session-store.js";
import type { RequestSteeringInbox } from "./request-steering.js";
import type { RequestModelStepPort } from "../model/model-step-port.js";
import type {
  RequestSessionMemory,
  SessionMemoryCompactor,
} from "../context/session-memory/index.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { RegisteredToolEffectPersistence } from "../adapters/registered-tool-normal-invocations/shared/contracts.js";
import type { ToolNormalInvocationInput } from "../../capabilities/normal-invocation/contracts.js";
import type { ToolRequestAttachment } from "../../capabilities/tool-types.js";

export type RunRequestMessage = {
  type: string;
  requestId: string;
  sessionId?: unknown;
  input?: string;
  text?: string;
  agentMode?: unknown;
  modelPreference?: unknown;
  reasoningPreference?: unknown;
  toolPermissionMode?: unknown;
  attachments?: unknown;
};

export type RequestHandlerOptions = SessionMemoryCompactorComposition & {
  /** Opted-in client; the managed owner supplies the trusted activation below. */
  durableApprovals?: boolean;
  /** Acknowledges canonical admission before request execution begins. */
  onAccepted?: () => void | Promise<void>;
  /** Trusted same-request handoff; never accepted from client JSON. */
  sessionAdmission?: SessionRequestAdmissionClaim;
  approvalExecution?: RequestApprovalExecution;
  abortSignal?: AbortSignal;
  /** Synchronously close cancellation before final-response persistence starts. */
  claimFinalization?: () => void;
  runtimeConfig?: RuntimeConfig;
  eventSinkFactory?: EventSinkFactory;
  modelGatewayClient?: ModelGatewayClient;
  sessionStore?: RequestSessionStore;
  attachmentStore?: RuntimeAttachmentStore;
  toolRegistry?: ToolRegistry;
  knowledgeSkillStore?: KnowledgeSkillStore;
  informationBasket?: InformationBasketService;
  toolApprovalController?: ToolApprovalController;
  requestSteering?: RequestSteeringInbox;
  /** Trusted automation-only receipt boundary; never accepted from client JSON. */
  effectPersistence?: RegisteredToolEffectPersistence;
  /** Internal Agent-node result shape; never accepted from client JSON. */
  automationOutputContract?: ToolNormalInvocationInput;
  /** Validated run-manifest handles for an Automation Agent; never accepted from client JSON. */
  automationInputAttachments?: readonly ToolRequestAttachment[];
  sessionMemoryCompactor?: SessionMemoryCompactor;
  longTermMemory?: LongTermMemoryService;
};

/** Exact provider-free seed used to construct one request execution scope. */
export type RequestExecutionSeed = Readonly<{
  toolResources?: RequestToolResources;
  approvalGate?: CapabilityApprovalGate;
  /** Disambiguates model invocations across durable execution segments. */
  modelInvocationScope?: string;
  requestId: string;
  sessionId: string;
  prompt: string;
  temporalContext?: RequestTemporalContext;
  scheduledExecution?: ScheduleMessageReference;
  /** Trusted persisted session identity; controls root presentation only. */
  sessionKind?: "spark";
  historyMessages: readonly RequestHistoryMessage[];
  sessionArtifactPaths?: readonly string[];
  shouldGenerateSessionTitle: boolean;
  runnerConfig: RequestRunnerConfig;
  /** Resolved once by the production request handler before runner entry. */
  executionPolicySelection?: RequestExecutionPolicySelection;
  attachments?: ModelGatewayAttachment[];
  agentMode: AgentMode;
  modelPreference?: ModelPreference;
  reasoningPreference?: ModelReasoningPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
  modelGatewayClient: Pick<
    ModelGatewayClient,
    "invoke" | "invokeRaw" | "countInputTokens"
  >;
  contextCompactionStore?: RequestContextCompactionStore;
  sessionMemory?: RequestSessionMemory;
  longTermMemory?: LongTermMemoryService;
  /** Frozen request-local availability limit for explicit memory recall. */
  memoryRecallLimit?: number;
  requestSteering?: RequestSteeringInbox;
  effectPersistence?: RegisteredToolEffectPersistence;
  automationOutputContract?: ToolNormalInvocationInput;
  toolPermissionMode: ToolPermissionMode;
  toolApprovalController?: ToolApprovalController;
  abortSignal: AbortSignal;
  userInteractions?: RequestUserInteractions;
  onAcknowledgement: (acknowledgement: string) => void;
  onSessionTitle: (title: string) => Promise<void>;
  onThinkingDelta: (delta: string) => void;
  onThinkingTrace: (entry: RuntimeThinkingTrace) => void;
  onAnswerToken: (token: string) => void;
  onEvent: (name: string, extra?: Record<string, unknown>) => void;
}>;

/** Stable request/session identity shared by every request-scoped facet. */
export type RequestIdentity = Readonly<{
  requestId: RequestExecutionSeed["requestId"];
  sessionId: RequestExecutionSeed["sessionId"];
}>;

/** Accepted client input and request controls; no derived runtime services. */
export type AcceptedRequestInput = Readonly<{
  prompt: RequestExecutionSeed["prompt"];
  temporalContext?: RequestExecutionSeed["temporalContext"];
  scheduledExecution?: RequestExecutionSeed["scheduledExecution"];
  attachments?: RequestExecutionSeed["attachments"];
  automationOutputContract?: RequestExecutionSeed["automationOutputContract"];
  agentMode: RequestExecutionSeed["agentMode"];
}>;

/** Immutable session snapshot captured before request execution begins. */
export type RequestSessionSnapshot = Readonly<{
  sessionKind?: RequestExecutionSeed["sessionKind"];
  historyMessages: RequestExecutionSeed["historyMessages"];
  sessionArtifactPaths?: RequestExecutionSeed["sessionArtifactPaths"];
  shouldGenerateSessionTitle: RequestExecutionSeed["shouldGenerateSessionTitle"];
  contextCompactionStore?: RequestExecutionSeed["contextCompactionStore"];
  sessionMemory?: RequestExecutionSeed["sessionMemory"];
}>;

/** Model configuration and gateway selected once for this request. */
export type RequestModelRuntime = Readonly<{
  toolResources?: RequestExecutionSeed["toolResources"];
  modelInvocationScope?: RequestExecutionSeed["modelInvocationScope"];
  runnerConfig: RequestExecutionSeed["runnerConfig"];
  modelPreference?: RequestExecutionSeed["modelPreference"];
  reasoningPreference?: RequestExecutionSeed["reasoningPreference"];
  modelPolicy?: RequestExecutionSeed["modelPolicy"];
  modelGatewayClient: RequestExecutionSeed["modelGatewayClient"];
}>;

/** Core-owned passive memory service; never part of capability execution. */
export type RequestMemoryRuntime = Readonly<{
  longTermMemory?: RequestExecutionSeed["longTermMemory"];
  memoryRecallLimit?: RequestExecutionSeed["memoryRecallLimit"];
}>;

/** Request-local cancellation, steering, capability controls, and events. */
export type RequestLifecycleRuntime = Readonly<{
  approvalGate?: RequestExecutionSeed["approvalGate"];
  requestSteering?: RequestExecutionSeed["requestSteering"];
  effectPersistence?: RequestExecutionSeed["effectPersistence"];
  toolPermissionMode: RequestExecutionSeed["toolPermissionMode"];
  toolApprovalController?: RequestExecutionSeed["toolApprovalController"];
  abortSignal: RequestExecutionSeed["abortSignal"];
  onEvent: RequestExecutionSeed["onEvent"];
}>;

/** Client-facing request presentation callbacks. */
export type RequestPresentation = Readonly<{
  userInteractions?: RequestExecutionSeed["userInteractions"];
  onAcknowledgement: RequestExecutionSeed["onAcknowledgement"];
  onSessionTitle: RequestExecutionSeed["onSessionTitle"];
  onThinkingDelta: RequestExecutionSeed["onThinkingDelta"];
  onThinkingTrace: RequestExecutionSeed["onThinkingTrace"];
  onAnswerToken: RequestExecutionSeed["onAnswerToken"];
}>;

/** The exact request-owned surface required by model invocation. */
export type RequestModelInvocationView = Readonly<
  Pick<
    RequestExecutionSeed,
    | "requestId"
    | "toolResources"
    | "modelInvocationScope"
    | "runnerConfig"
    | "agentMode"
    | "modelPreference"
    | "reasoningPreference"
    | "modelPolicy"
    | "modelGatewayClient"
    | "requestSteering"
    | "abortSignal"
    | "onThinkingDelta"
    | "onThinkingTrace"
  >
>;

/**
 * Nominal marker for a request that already owns its single model-step port.
 * It is non-enumerable on canonical request views, so it cannot enter model or
 * provider payloads through spread/JSON projection.
 */
export const BOUND_REQUEST_MODEL_INVOCATION = Symbol(
  "bound_request_model_invocation",
);

export type BoundRequestModelInvocationContext = RequestModelInvocationView &
  Readonly<{
    [BOUND_REQUEST_MODEL_INVOCATION]: true;
    modelSteps: RequestModelStepPort;
  }>;
