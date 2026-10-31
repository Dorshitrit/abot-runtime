import type { ModelGatewayPolicyConfig } from "../../../model-gateway/types.js";

/** Explicit declaration for the supported OpenAI caching fixture only. */
export const executionPrefixCachePolicy: ModelGatewayPolicyConfig = {
  providers: { openai: { type: "openai" } },
  profiles: { test: {
    provider: "openai", model: "test", contextWindowTokens: 32000,
    options: { prompt_cache_options: { mode: "implicit" } },
  } },
  defaults: { profileId: "test", steps: {
    "execution.decision": "execution.decision", "execution.response": "execution.response",
    "capability.controls": "capability.controls", "context.compact": "context.compact",
  } },
};
