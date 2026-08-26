import type {
  ModelGatewayAttachment,
  ModelGatewayPolicyConfig,
  ModelPreference,
} from "../../model-gateway/types.js";
import type { AgentMode } from "../../shared/types.js";
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
import type { RequestTemporalContext } from "../context/request-temporal-context.js";
import type { RequestSessionStore } from "./session-store.js";
import type { RequestSteeringInbox } from "./request-steering.js";
import type { RequestModelStepPort } from "../model/model-step-port.js";
import type {
  RequestSessionMemory,
  SessionMemoryCompactor,
} from "../context/session-memory/index.js";

export type RunRequestMessage = {
  type: string;
  requestId: string;
  sessionId?: unknown;
  input?: string;
  text?: string;
  agentMode?: unknown;
  modelPreference?: unknown;
  toolPermissionMode?: unknown;
  attachments?: unknown;
};

export type RequestHandlerOptions = {
  runtimeConfig?: RuntimeConfig;
  eventSinkFactory?: EventSinkFactory;
  modelGatewayClient?: ModelGatewayClient;
  sessionStore?: RequestSessionStore;
  attachmentStore?: RuntimeAttachmentStore;
  toolRegistry?: ToolRegistry;
  toolApprovalController?: ToolApprovalController;
  requestSteering?: RequestSteeringInbox;
  sessionMemoryCompactor?: SessionMemoryCompactor;
};

/** Exact provider-free seed used to construct one request execution scope. */
export type RequestExecutionSeed = Readonly<{
  requestId: string;
  sessionId: string;
  prompt: string;
  temporalContext?: RequestTemporalContext;
  historyMessages: readonly RequestHistoryMessage[];
  sessionArtifactPaths?: readonly string[];
  shouldGenerateSessionTitle: boolean;
  runnerConfig: RequestRunnerConfig;
  /** Resolved once by the production request handler before runner entry. */
  executionPolicySelection?: RequestExecutionPolicySelection;
  attachments?: ModelGatewayAttachment[];
  agentMode: AgentMode;
  modelPreference?: ModelPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
  modelGatewayClient: Pick<
    ModelGatewayClient,
    "invoke" | "invokeRaw" | "countInputTokens"
  >;
  contextCompactionStore?: RequestContextCompactionStore;
  sessionMemory?: RequestSessionMemory;
  requestSteering?: RequestSteeringInbox;
  toolPermissionMode: ToolPermissionMode;
  toolApprovalController?: ToolApprovalController;
  abortSignal: AbortSignal;
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
  attachments?: RequestExecutionSeed["attachments"];
  agentMode: RequestExecutionSeed["agentMode"];
}>;

/** Immutable session snapshot captured before request execution begins. */
export type RequestSessionSnapshot = Readonly<{
  historyMessages: RequestExecutionSeed["historyMessages"];
  sessionArtifactPaths?: RequestExecutionSeed["sessionArtifactPaths"];
  shouldGenerateSessionTitle: RequestExecutionSeed["shouldGenerateSessionTitle"];
  contextCompactionStore?: RequestExecutionSeed["contextCompactionStore"];
  sessionMemory?: RequestExecutionSeed["sessionMemory"];
}>;

/** Model configuration and gateway selected once for this request. */
export type RequestModelRuntime = Readonly<{
  runnerConfig: RequestExecutionSeed["runnerConfig"];
  modelPreference?: RequestExecutionSeed["modelPreference"];
  modelPolicy?: RequestExecutionSeed["modelPolicy"];
  modelGatewayClient: RequestExecutionSeed["modelGatewayClient"];
}>;

/** Request-local cancellation, steering, capability controls, and events. */
export type RequestLifecycleRuntime = Readonly<{
  requestSteering?: RequestExecutionSeed["requestSteering"];
  toolPermissionMode: RequestExecutionSeed["toolPermissionMode"];
  toolApprovalController?: RequestExecutionSeed["toolApprovalController"];
  abortSignal: RequestExecutionSeed["abortSignal"];
  onEvent: RequestExecutionSeed["onEvent"];
}>;

/** Client-facing request presentation callbacks. */
export type RequestPresentation = Readonly<{
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
    | "runnerConfig"
    | "agentMode"
    | "modelPreference"
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
