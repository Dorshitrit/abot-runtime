import { randomUUID } from "node:crypto";
import { modelIssueObserver } from "./model-issue-event.js";
import type {
  ChatMessage,
  ModelGatewayFormat,
  ResolvedModelInvocation,
} from "../../model-gateway/types.js";
import { projectPromptCacheBoundary } from "./prompt-cache-boundary.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { RequestModelInvocationView } from "../request/contracts.js";

export async function countModelInputTokens(params: {
  request: RequestModelInvocationView;
  invocation: ResolvedModelInvocation;
  modelStep: ModelStep;
  messages: readonly ChatMessage[];
  promptCacheBoundaryBeforeMessage?: ChatMessage;
  format?: ModelGatewayFormat;
  abortSignal?: AbortSignal;
  onEvent?: (name: string, extra?: Record<string, unknown>) => void;
}): Promise<number | undefined> {
  const abortSignal = params.abortSignal ?? params.request.abortSignal;
  abortSignal.throwIfAborted();
  const countInputTokens = params.request.modelGatewayClient.countInputTokens;
  if (!countInputTokens) {
    return undefined;
  }
  const result = await countInputTokens({
    onIssue: modelIssueObserver({ requestId: params.request.requestId,
      invocationId: randomUUID(), modelStep: params.modelStep, onEvent: params.onEvent }),
    provider: params.invocation.profile.provider,
    messages: params.messages,
    ...projectPromptCacheBoundary({ messages: params.messages, beforeMessage: params.promptCacheBoundaryBeforeMessage }),
    agentMode: params.request.agentMode,
    modelStep: params.modelStep,
    ...(params.request.reasoningPreference ? { reasoningPreference: params.request.reasoningPreference } : {}),
      ...(params.request.modelPreference
      ? { modelPreference: params.request.modelPreference }
      : {}),
    ...(params.request.modelPolicy
      ? { modelPolicy: params.request.modelPolicy }
      : {}),
    abortSignal,
    debugRequestId: params.request.requestId,
    ...(params.request.sessionId ? { promptCacheScope: params.request.sessionId } : {}),
    ...(params.format !== undefined ? { format: params.format } : {}),
  });
  abortSignal.throwIfAborted();
  if (!result) {
    return undefined;
  }
  const profile = params.invocation.profile;
  if (
    result.profileId !== profile.id ||
    result.provider !== profile.provider ||
    result.model !== params.invocation.model ||
    result.contextWindowTokens !== profile.contextWindowTokens
  ) {
    throw new Error("model_input_token_count_binding_mismatch");
  }
  traceDebug("runtime.context", "input_tokens.measured", {
    requestId: params.request.requestId,
    modelStep: params.modelStep,
    profileId: result.profileId,
    provider: result.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    source: result.source,
  });
  return result.inputTokens;
}
