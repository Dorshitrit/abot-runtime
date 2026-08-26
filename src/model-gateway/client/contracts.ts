import type {
  AgentMode,
  ModelReasoningLevel,
  ModelStep,
} from "../../shared/types.js";
import type { StreamCallbacks } from "../client-stream-parser.js";
import type {
  ModelGatewayAttachment,
  ModelGatewayPolicyConfig,
  ModelPreference,
  ModelTokenUsage,
} from "../types.js";

export type ModelMetricMessage = {
  role: string;
  content: string;
  systemMessageKind?: string;
  contextMessageKind?: string;
  attachments?: ModelGatewayAttachment[];
  toolCallCount?: number;
  toolResultCount?: number;
};

export type InvokeModelGatewayParams = StreamCallbacks & {
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

export type InvokeRawModelGatewayParams = {
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

export type ModelGatewayClientOptions = {
  baseUrl?: string;
  streamInactivityTimeoutMs?: number;
  modelPolicy?: ModelGatewayPolicyConfig;
  inputTokenCountProviders?: readonly string[];
};

export type EmptyResponseReason =
  | "thinking_only_response"
  | "parser_or_stream_assembly_failure"
  | "unrecognized_stream_event_shape"
  | "content_events_without_text"
  | "empty_stream_body"
  | "unknown_empty_response";

export type StreamMeta = {
  status: number;
  chunkCount: number;
  totalBytes: number;
  thinkingEvents: number;
  contentEvents: number;
  contentEmptyEvents: number;
  invalidJsonLines: number;
  unknownTypeCounts: Record<string, number>;
  outputLength: number;
  terminalEventCount: number;
  providerCompletionReason?: string | null;
  emptyReason?: EmptyResponseReason;
  usage?: ModelTokenUsage;
};

export type RawModelGatewayResult = {
  text: string;
  meta: {
    status: number;
    outputLength: number;
    thinkingLength: number;
    providerCompletionReason?: string | null;
    usage?: ModelTokenUsage;
  };
};
