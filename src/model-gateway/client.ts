import { invokeModelGatewayWithOptions } from "./client/chat.js";
import type {
  InvokeModelGatewayParams,
  InvokeRawModelGatewayParams,
  ModelGatewayClientOptions,
  ModelMetricMessage,
  RawModelGatewayResult,
  StreamMeta,
} from "./client/contracts.js";
import {
  countModelGatewayInputTokensWithOptions,
  type InputTokenCountCache,
} from "./client/input-token-count.js";
import { buildModelInvocationMetrics } from "./client/invocation-metrics.js";
import { projectModelGatewayMetricMessages } from "./client/message-projection.js";
import { getModelGatewayStreamInactivityTimeoutMs } from "./client/options.js";
import { invokeRawModelGatewayWithOptions } from "./client/raw.js";
import { classifyEmptyResponse } from "./client/stream-consumer.js";
import { embedModelGatewayWithOptions } from "./client/embeddings.js";
import type {
  ModelGatewayEmbeddingParams,
  ModelGatewayEmbeddingResult,
  ModelGatewayInputTokenCountParams,
  ModelGatewayInputTokenCountResult,
} from "./types.js";

export type { ModelGatewayClientOptions, ModelMetricMessage };
export {
  buildModelInvocationMetrics,
  classifyEmptyResponse,
  getModelGatewayStreamInactivityTimeoutMs,
  projectModelGatewayMetricMessages,
};

export async function invokeModelGateway(
  params: InvokeModelGatewayParams,
): Promise<{ text: string; meta: StreamMeta }> {
  return invokeModelGatewayWithOptions(params);
}

export async function countModelGatewayInputTokens(
  params: ModelGatewayInputTokenCountParams,
): Promise<ModelGatewayInputTokenCountResult | undefined> {
  return countModelGatewayInputTokensWithOptions(params);
}

export async function invokeRawModelGateway(
  params: InvokeRawModelGatewayParams,
): Promise<RawModelGatewayResult> {
  return invokeRawModelGatewayWithOptions(params);
}

export async function embedModelGateway(
  params: ModelGatewayEmbeddingParams,
): Promise<ModelGatewayEmbeddingResult> {
  return embedModelGatewayWithOptions(params);
}

export function createModelGatewayClient(
  options: ModelGatewayClientOptions = {},
): {
  invoke: typeof invokeModelGateway;
  invokeRaw: typeof invokeRawModelGateway;
  countInputTokens: typeof countModelGatewayInputTokens;
  embed: typeof embedModelGateway;
} {
  const inputTokenCountCache: InputTokenCountCache = new Map();
  return {
    invoke: (params) => invokeModelGatewayWithOptions(params, options),
    invokeRaw: (params) => invokeRawModelGatewayWithOptions(params, options),
    embed: (params) => embedModelGatewayWithOptions(params, options),
    countInputTokens: (params) =>
      countModelGatewayInputTokensWithOptions(
        params,
        options,
        inputTokenCountCache,
      ),
  };
}
