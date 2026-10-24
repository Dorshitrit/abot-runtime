import type { ModelProviderAdapterRegistry } from "../../../model-gateway/index.js";
import type { LongTermMemoryOnboardingProvider } from "../../long-term-memory/onboarding/contracts.js";

/** Chat-only adapters must not be advertised as usable embedding connections. */
export function availableEmbeddingProviders(
  providers: readonly LongTermMemoryOnboardingProvider[],
  adapters: ModelProviderAdapterRegistry,
): readonly LongTermMemoryOnboardingProvider[] {
  return providers.filter((provider) => {
    try { return typeof adapters.resolve(provider.type).embed === "function"; }
    catch { return false; }
  });
}
