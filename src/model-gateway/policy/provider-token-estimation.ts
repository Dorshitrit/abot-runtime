import type { ModelContextConfig, ModelTokenEstimationConfig } from "../types.js";

// A provider estimate, not an exact tokenizer count. Preserve the more
// conservative non-ASCII charge and the existing message framing allowance.
const CHATGPT_TOKEN_ESTIMATION: Readonly<Required<ModelTokenEstimationConfig>> = {
  asciiCharactersPerToken: 4,
  nonAsciiBytesPerToken: 2,
  messageOverheadTokens: 6,
};

function usesChatGPTTokenEstimation(provider: string): boolean {
  return provider === "openai-chatgpt";
}

/** Apply provider defaults only after the ordinary context overlay is resolved. */
export function applyProviderTokenEstimationDefaults(
  provider: string,
  context: ModelContextConfig,
): ModelContextConfig {
  if (!usesChatGPTTokenEstimation(provider)) {
    return context;
  }
  return {
    ...context,
    tokenEstimation: {
      ...CHATGPT_TOKEN_ESTIMATION,
      ...context.tokenEstimation,
    },
  };
}
