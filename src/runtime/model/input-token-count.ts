import type {
  ChatMessage,
  ModelGatewayFormat,
  ResolvedModelInvocation,
} from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { RequestModelInvocationView } from "../request/contracts.js";

export async function countModelInputTokens(params: {
  request: RequestModelInvocationView;
  invocation: ResolvedModelInvocation;
  modelStep: ModelStep;
  messages: readonly ChatMessage[];
  format?: ModelGatewayFormat;
}): Promise<number | undefined> {
  const countInputTokens = params.request.modelGatewayClient.countInputTokens;
  if (!countInputTokens) {
    return undefined;
  }
  const result = await countInputTokens({
    provider: params.invocation.profile.provider,
    messages: params.messages,
    agentMode: params.request.agentMode,
    modelStep: params.modelStep,
    ...(params.request.modelPreference
      ? { modelPreference: params.request.modelPreference }
      : {}),
    ...(params.request.modelPolicy
      ? { modelPolicy: params.request.modelPolicy }
      : {}),
    abortSignal: params.request.abortSignal,
    debugRequestId: params.request.requestId,
    ...(params.format !== undefined ? { format: params.format } : {}),
  });
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
