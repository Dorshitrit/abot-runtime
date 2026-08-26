import type {
  AgentMode,
  ModelReasoningLevel,
  ModelStep,
} from "../shared/types.js";
import type { RuntimeAttachmentReference } from "../shared/attachments.js";

/** Stable adapter identifier. Built-ins currently register `ollama` and `openai`. */
export type ModelProvider = string;

export type ChatTextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  attachments?: ModelGatewayAttachment[];
  toolCalls?: never;
};

export type ModelGatewayToolCall = Readonly<{
  /** Canonical call identity shared with the matching result. */
  callId: string;
  /** Provider-safe function name shared with the matching result. */
  name: string;
  /** Exact JSON arguments. Provider projection must not semantically rewrite it. */
  arguments: string;
}>;

export type ChatAssistantToolCallMessage = Readonly<{
  role: "assistant";
  /** Tool action JSON lives only in toolCalls[].arguments. */
  content: "";
  toolCalls: readonly ModelGatewayToolCall[];
  attachments?: never;
}>;

export type ChatToolResultMessage = Readonly<{
  role: "tool";
  /** Exact output from the mechanically linked call. */
  content: string;
  toolCallId: string;
  toolName: string;
  attachments?: never;
  toolCalls?: never;
}>;

export type ChatMessage =
  | ChatTextMessage
  | ChatAssistantToolCallMessage
  | ChatToolResultMessage;

export type ModelGatewayAttachment = RuntimeAttachmentReference & {
  data?: string;
};

export type ModelGatewayJsonSchemaFormat = {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
  description?: string;
  strict?: boolean;
  /**
   * Exact constraints that the owning parser/runtime enforces after generation.
   * A provider projector may remove only a listed keyword at the listed JSON
   * Pointer and must diagnose every removal.
   */
  postValidatedSchemaConstraints?: readonly Readonly<{
    keyword: "maxLength";
    path: string;
  }>[];
};

export type ModelGatewayFormat =
  | "json"
  | ModelGatewayJsonSchemaFormat
  | Record<string, unknown>;

export type ModelPreferenceScope = "main" | "all";

export type ModelPreference = {
  profileId: string;
  scope?: ModelPreferenceScope;
};

export type ModelGatewayProfileConfig = {
  label?: string;
  configRef?: string;
  provider?: string;
  model: string;
  /** Declared physical context capacity. Required after profile materialization. */
  contextWindowTokens?: number;
  supportsThinking?: boolean;
  capabilities?: ModelGatewayProfileCapabilities;
  options?: Record<string, unknown>;
  generation?: ModelGenerationConfig;
  context?: ModelContextConfig;
  calibration?: Record<string, ModelStepCalibrationConfig>;
};

export type ModelModality = "text" | "image" | "audio";

export type ModelGatewayProfileCapabilities = {
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
};

export type ModelGatewayProviderConfig = {
  type: ModelProvider;
  baseUrl?: string;
  apiKeyEnv?: string;
  keepAlive?: string;
  /** Provider-owned JSON configuration outside the shared transport fields. */
  settings?: Record<string, unknown>;
};

export type ModelGenerationConfig = {
  temperature?: number;
  topP?: number;
  reasoningEffort?: ModelReasoningLevel;
};

export type ModelTokenEstimationConfig = {
  asciiCharactersPerToken?: number;
  nonAsciiBytesPerToken?: number;
  messageOverheadTokens?: number;
};

export type ModelFormatTokenAccountingConfig = {
  mode: "none" | "estimate";
  fixedOverheadTokens?: number;
};

export type ModelContextConfig = {
  formatTokenAccounting?: ModelFormatTokenAccountingConfig;
  tokenEstimation?: ModelTokenEstimationConfig;
};

export type ModelGatewayPolicyDefaults = {
  overrideClientPreference?: boolean;
  profileId?: string;
  roles?: Record<string, string>;
  steps?: Record<string, string>;
  context?: ModelContextConfig;
};

export type ModelInvocationProfileConfig = {
  profileId: string;
  generation?: ModelGenerationConfig;
  context?: ModelContextConfig;
  format?: ModelGatewayFormat;
};

export type ModelStepCalibrationConfig = {
  profileId?: string;
  timeoutMs?: number;
  generation?: ModelGenerationConfig;
  context?: ModelContextConfig;
  format?: ModelGatewayFormat;
  instructions?: string[];
};

export type ModelGatewayPolicyConfig = {
  providers?: Record<string, ModelGatewayProviderConfig>;
  profiles?: Record<string, ModelGatewayProfileConfig>;
  invocationProfiles?: Record<string, ModelInvocationProfileConfig>;
  defaults?: ModelGatewayPolicyDefaults;
};

export type ModelGatewayRequest = {
  text?: string;
  prompt?: string;
  messages?: unknown;
  debugRequestId?: string;
  agentMode?: AgentMode | string;
  taskType?: string;
  modelStep?: ModelStep | string;
  modelOverride?: string;
  reasoningOverride?: ModelReasoningLevel | string;
  format?: unknown;
  modelPreference?: ModelPreference;
  modelPolicy?: ModelGatewayPolicyConfig;
};

export type ModelGatewayInputTokenCountParams = {
  /** Local capability hint only; the gateway still resolves and verifies the provider. */
  provider: ModelProvider;
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

export type ModelGatewayInputTokenCountResult = Readonly<{
  inputTokens: number;
  profileId: string;
  provider: ModelProvider;
  model: string;
  contextWindowTokens: number;
  source: "provider_input_token_count";
}>;

export type ModelProfile = {
  id: string;
  label: string;
  providerId: string;
  provider: ModelProvider;
  providerConfig?: ModelGatewayProviderConfig;
  model: string;
  contextWindowTokens: number;
  supportsThinking: boolean;
  capabilities: Required<ModelGatewayProfileCapabilities>;
  options: Record<string, unknown>;
  generation: ModelGenerationConfig;
  context: ModelContextConfig;
  calibration?: Record<string, ModelStepCalibrationConfig>;
};

export type ResolvedModelInvocation = {
  profile: ModelProfile;
  model: string;
  think?: ModelReasoningLevel;
  format?: ModelGatewayFormat;
  instructions?: string[];
};

export type ModelGatewayEvent =
  | { type: "thinking"; text: string }
  | { type: "content"; text: string }
  | { type: "error"; error: string }
  | {
      type: "done";
      done: true;
      doneReason: string | null;
      usage?: ModelTokenUsage;
    };

export type ModelTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
};
