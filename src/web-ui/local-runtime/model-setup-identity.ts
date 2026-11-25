import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import {
  buildModelConfig,
  readJsonObject,
  resolveRuntimePackageRoot,
} from "../../../scripts/runtime-setup-files.js";
import { ModelSetupError, type ModelSetupInput } from "./model-setup-input.js";
import type { planModelProvider } from "./model-setup-provider.js";
import { requireSetupReasoningSummaryProvider } from "../../model-gateway/providers/openai/setup-reasoning-summary.js";

type ModelProviderPlan = ReturnType<typeof planModelProvider>;

export async function prepareModelSetupProfile(
  provider: ModelProviderPlan,
  input: ModelSetupInput,
) {
  try { requireSetupReasoningSummaryProvider(String(provider.config.type), input.reasoningSummary); } catch (error) {
    throw new ModelSetupError("invalid_model_reasoning_summary", (error as Error).message);
  }
  const template = await readJsonObject(
    join(
      resolveRuntimePackageRoot(import.meta.dirname),
      "examples/models/default.config.json",
    ),
  );
  const buildProfile = (applyCreationTemperature = false, applyLegacyCompactionDefaults = false) => ({
    ...buildModelConfig(
      template,
      String(provider.config.type),
      input.model,
      input.contextWindowTokens,
      input,
      undefined,
      applyCreationTemperature,
      applyLegacyCompactionDefaults,
    ),
    provider: provider.id,
  });
  const profile = buildProfile();
  return {
    profile,
    matchesSaved(saved: Record<string, unknown>) {
      if (isDeepStrictEqual(saved, profile)) return true;
      // Compare complete historical shapes; never rewrite a saved profile on retry.
      if (isDeepStrictEqual(saved, buildProfile(true, true))) return true;
      return isDeepStrictEqual(saved, buildProfile(false, true));
    },
  };
}

export type PreparedModelSetupProfile = Awaited<ReturnType<typeof prepareModelSetupProfile>>;

export function modelSetupResult(
  provider: ModelProviderPlan,
  input: ModelSetupInput,
) {
  return {
    model: {
      profileId: input.profileId,
      providerId: provider.id,
      provider: String(provider.config.type),
      model: input.model,
    },
    restartRequired: true as const,
  };
}
