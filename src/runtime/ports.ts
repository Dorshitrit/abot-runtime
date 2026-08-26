import type WebSocket from "ws";

import type {
  AgentMode,
  ModelReasoningLevel,
  ModelStep,
} from "../shared/types.js";
import type {
  ContextBuckets,
  ModelContextMessage,
} from "../sessions/context-window.js";
import type {
  SessionArtifactPathInput,
  SessionContextEntryKind,
  SessionDeleteResult,
  SessionListResult,
  SessionMessageDeleteResult,
  SessionMessageGrounding,
  SessionMessageObservationMeta,
  SessionMessageRole,
  SessionMessageSource,
  SessionMessageTaskType,
  SessionMessagesClearResult,
  SessionRecord,
  SessionRequestReplay,
  SessionSnapshot,
  SessionThinkingTraceEntry,
} from "../sessions/types.js";
import type { SessionMemoryRepository } from "../sessions/memory/contracts.js";
import type {
  ModelGatewayInputTokenCountParams,
  ModelGatewayInputTokenCountResult,
  ModelGatewayPolicyConfig,
  ModelPreference,
  ModelTokenUsage,
} from "../model-gateway/types.js";
import type { RuntimeAttachmentStore } from "./attachments/store.js";
import type { RuntimeAttachmentReference } from "../shared/attachments.js";
import type { StreamCallbacks } from "../model-gateway/client-stream-parser.js";
import type {
  ToolCall,
  ToolCallAdapter,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutionSharedState,
  ToolImplementation,
  RegisteredToolNormalInvocation,
} from "../capabilities/tool-types.js";
import type { RequestLifecycleState } from "./orchestration/lifecycle/request-lifecycle.js";
import type { RuntimeModelExecutionPolicies } from "./config/model-execution-policy.js";

export type RuntimePaths = {
  rootDir: string;
  runtimeDir: string;
  agentWorkDir: string;
  sessionsDir: string;
  attachmentsDir: string;
  workspaceDir: string;
  sharedDir: string;
  compiledDir: string;
  traceFile: string;
};

export type RuntimeTimeouts = {
  requestTimeoutMs?: number;
  requestInactivityTimeoutMs?: number;
  modelStepTimeoutMs?: number;
  streamInactivityTimeoutMs?: number;
};

export type RuntimeLogRotationConfig = {
  maxFileSizeMb: number;
  maxFiles: number;
  maxAgeDays: number;
};

export type RuntimeLoggingConfig = {
  enabled: boolean;
  rotation: RuntimeLogRotationConfig;
};

export type RuntimeModelConfig = ModelGatewayPolicyConfig;

export type RuntimeRequestRunnerConfig = {
  /** Absolute path resolved from requestRunner.configRef in runtime config. */
  configPath: string;
};

export type RuntimePluginConfig = {
  enabled?: boolean;
  allow?: string[];
  deny?: string[];
};

export type RuntimeConfig = {
  runtimeId: string;
  agentBridgeUrl: string;
  agentBridgeToken?: string;
  modelGatewayUrl: string;
  paths: RuntimePaths;
  logging?: RuntimeLoggingConfig;
  timeouts?: RuntimeTimeouts;
  plugins?: RuntimePluginConfig;
  models?: RuntimeModelConfig;
  modelExecutionPolicies?: RuntimeModelExecutionPolicies;
  requestRunner: RuntimeRequestRunnerConfig;
  modelPreference?: ModelPreference;
  featureFlags?: Record<string, boolean | number | string>;
};

export type RuntimeHostStartOptions = {
  runtimeConfig?: RuntimeConfig;
  runtimeId?: string;
  agentBridgeUrl?: string;
  agentBridgeToken?: string;
  eventSinkFactory?: EventSinkFactory;
  modelGatewayClient?: ModelGatewayClient;
  sessionStore?: SessionStore;
  attachmentStore?: RuntimeAttachmentStore;
  toolRegistry?: ToolRegistry;
};

export type RuntimeHostHandle = {
  stop: () => Promise<void>;
};

export type RuntimeHost = {
  start: (options?: RuntimeHostStartOptions) => RuntimeHostHandle;
};

export type AppendSessionMessageOptions = {
  lastAgentMode?: AgentMode;
  grounding?: SessionMessageGrounding;
  observationMeta?: SessionMessageObservationMeta;
  observationContent?: string;
  thinkingTrace?: SessionThinkingTraceEntry[];
  source?: SessionMessageSource;
  taskType?: SessionMessageTaskType;
  requestId?: string;
  cronJobId?: string;
  cronTitle?: string;
  triggerType?: string;
  attachments?: RuntimeAttachmentReference[];
};

export type AppendSessionContextEntryOptions = {
  kind: SessionContextEntryKind;
  content: string;
  observationMeta: SessionMessageObservationMeta;
  requestId?: string;
};

export type SessionStore = SessionMemoryRepository & {
  getOrCreateSession: (sessionId: string) => Promise<SessionRecord>;
  getAllSessions: () => Promise<SessionRecord[]>;
  listSessions: (params?: {
    limit?: number;
    cursor?: string | null;
  }) => Promise<SessionListResult>;
  getSessionById: (sessionId: string) => Promise<SessionRecord | null>;
  getSessionSnapshot: (
    sessionId: string,
    options?: {
      afterMessageId?: string | number | null;
      includeRequests?: boolean;
    },
  ) => Promise<SessionSnapshot | null>;
  getRequestReplayById: (
    requestId: string,
    afterSeq?: number,
  ) => Promise<SessionRequestReplay | null>;
  updateSessionTitle: (
    sessionId: string,
    title: string,
  ) => Promise<SessionRecord | null>;
  updateSessionRuntimeMode?: (
    sessionId: string,
    runtimeModeId: string | null,
  ) => Promise<SessionRecord | null>;
  appendMessage: (
    sessionId: string,
    role: SessionMessageRole,
    content: string,
    options?: AppendSessionMessageOptions,
  ) => Promise<SessionRecord>;
  appendContextEntry?: (
    sessionId: string,
    options: AppendSessionContextEntryOptions,
  ) => Promise<SessionRecord>;
  upsertArtifactPaths?: (
    sessionId: string,
    inputs: readonly SessionArtifactPathInput[],
  ) => Promise<SessionRecord>;
  startRequestStream: (
    sessionId: string,
    requestId: string,
  ) => Promise<SessionRecord>;
  appendRequestEvent: (
    sessionId: string,
    requestId: string,
    payload: Record<string, unknown>,
  ) => Promise<SessionRecord>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  deleteSessionWithStats: (sessionId: string) => Promise<SessionDeleteResult>;
  resetSession: (sessionId: string) => Promise<SessionRecord | null>;
  clearSessionMessages: (
    sessionId: string,
  ) => Promise<SessionMessagesClearResult | null>;
  deleteMessage: (
    sessionId: string,
    messageId: string,
  ) => Promise<SessionRecord | null>;
  deleteMessageWithStats: (
    sessionId: string,
    messageId: string,
  ) => Promise<SessionMessageDeleteResult | null>;
};

export type ConversationContextProvider = {
  buildContextBuckets: (
    session: SessionRecord,
    options?: {
      maxConversationMessages?: number;
      maxToolObservationMessages?: number;
      includeRecentConversation?: boolean;
      includeRecentConversationAcrossTaskResults?: boolean;
    },
  ) => ContextBuckets;
  buildContextWindow: (
    session: SessionRecord,
    maxMessages?: number,
  ) => ModelContextMessage[];
};

export type ToolExecutionOptions = {
  abortSignal?: AbortSignal;
  sharedState?: ToolExecutionContext["sharedState"];
  modelInvoker?: ToolExecutionContext["modelInvoker"];
};

export type ToolPermissionMode = "full_access" | "ask";

export type ToolApprovalRequest = {
  requestId: string;
  approvalId: string;
  call: ToolCall;
  meta?: Record<string, unknown>;
};

export type ToolApprovalDecision = {
  approved: boolean;
  reason?: string;
};

export type ToolApprovalController = {
  requestToolApproval: (
    request: ToolApprovalRequest,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<ToolApprovalDecision>;
};

export type ToolRegistry = {
  listDefinitions: () => ToolDefinition[];
  /** The sole config-filtered availability snapshot for ordinary invocation. */
  listNormalInvocations?: () => readonly RegisteredToolNormalInvocation[];
  getDefinition: (name: string) => ToolDefinition | undefined;
  getAdapter?: (name: string) => ToolCallAdapter | undefined;
  hasToolsAvailable: () => boolean;
  getImplementations: () => Record<string, ToolImplementation>;
  prepareSharedState?: (
    sharedState?: ToolExecutionSharedState,
  ) => ToolExecutionSharedState;
  execute: (
    call: ToolCall,
    options?: ToolExecutionOptions,
  ) => Promise<ToolExecutionResult>;
};

export type SkillProvider = {
  getActionContext: (action: string) => Promise<string>;
};

export type WorkspaceProvider = {
  getSystemSummary: () => Promise<string>;
};

export type ModelGatewayInvokeParams = StreamCallbacks & {
  text?: string;
  messages?: unknown;
  agentMode: AgentMode;
  taskType?: string;
  modelStep?: ModelStep;
  modelOverride?: string;
  reasoningOverride?: ModelReasoningLevel;
  modelPreference?: ModelPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
  abortSignal: AbortSignal;
  debugRequestId?: string;
  format?: "json" | Record<string, unknown>;
};

export type ModelGatewayRawInvokeParams = {
  prompt: string;
  agentMode: AgentMode;
  taskType?: string;
  modelStep?: ModelStep;
  modelOverride?: string;
  reasoningOverride?: ModelReasoningLevel;
  modelPreference?: ModelPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
  abortSignal: AbortSignal;
  debugRequestId?: string;
  format?: "json" | Record<string, unknown>;
};

export type ModelGatewayInvokeResult = {
  text: string;
  meta: Record<string, unknown>;
};

export type ModelGatewayRawInvokeResult = {
  text: string;
  meta: {
    status: number;
    outputLength: number;
    thinkingLength: number;
    providerCompletionReason?: string | null;
    usage?: ModelTokenUsage;
  };
};

export type ModelGatewayClient = {
  invoke: (
    params: ModelGatewayInvokeParams,
  ) => Promise<ModelGatewayInvokeResult>;
  invokeRaw: (
    params: ModelGatewayRawInvokeParams,
  ) => Promise<ModelGatewayRawInvokeResult>;
  /** Undefined means the selected provider keeps the existing estimator path. */
  countInputTokens?: (
    params: ModelGatewayInputTokenCountParams,
  ) => Promise<ModelGatewayInputTokenCountResult | undefined>;
};

export type EventSink = {
  publish: (payload: Record<string, unknown>) => void | Promise<void>;
  event: (
    name: string,
    extra?: Record<string, unknown>,
  ) => void | Promise<void>;
  runtimeState: (state: RequestLifecycleState) => void | Promise<void>;
  token: (token: string) => void | Promise<void>;
  legacyToken: (text: string) => void | Promise<void>;
  thinkingDelta: (
    delta: string,
    accumulatedText: string,
  ) => void | Promise<void>;
  completed: (output: string) => void | Promise<void>;
  failed: (
    error: string,
    details?: Record<string, unknown>,
  ) => void | Promise<void>;
  drain: () => Promise<void>;
  dispose: () => void;
};

export type EventSinkFactory = {
  create: (options: {
    requestId: string;
    ws: WebSocket;
    persist?: (payload: Record<string, unknown>) => Promise<unknown>;
  }) => EventSink;
};
