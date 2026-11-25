import llamaCpp from "./llamacpp/parameter-capabilities.json" with { type: "json" };
import ollama from "./ollama/parameter-capabilities.json" with { type: "json" };
import openAI from "./openai/parameter-capabilities.json" with { type: "json" };
import chatGPT from "./openai-chatgpt/parameter-capabilities.json" with { type: "json" };
import type { ModelParameterConstraint, ModelParameterKey } from "../../shared/model-parameters.js";

export type ProviderParameterCapability = ModelParameterConstraint & Readonly<{
  path: readonly string[];
  nativeSentinels?: readonly number[];
  environmentOverride?: string;
  computedDefault?: string;
  compatibility?: NonNullable<ModelParameterConstraint["requires"]>;
}>;
export type ProviderParameterCapabilities = Readonly<{
  provider: string;
  nativeOptions?: boolean;
  /** Verified provider model output ceilings, independent of a caller's selected cap. */
  modelOutputTokenLimits?: Readonly<Record<string, number>>;
  parameters: Partial<Record<ModelParameterKey, ProviderParameterCapability>>;
}>;

const BUILT_IN_CAPABILITIES = Object.freeze([llamaCpp, ollama, openAI, chatGPT]) as readonly ProviderParameterCapabilities[];

export function getProviderParameterCapabilities(provider: string): ProviderParameterCapabilities {
  return BUILT_IN_CAPABILITIES.find((entry) => entry.provider === provider) ?? { provider, parameters: {} };
}
