import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import {
  buildModelConfig,
  readJsonObject,
  resolveRuntimePackageRoot,
} from "../../../scripts/runtime-setup-files.js";
import type { ModelSetupInput } from "./model-setup-input.js";
import type { planModelProvider } from "./model-setup-provider.js";

type ModelProviderPlan = ReturnType<typeof planModelProvider>;

export async function prepareModelSetupProfile(
  provider: ModelProviderPlan,
  input: ModelSetupInput,
) {
  const template = await readJsonObject(
    join(
      resolveRuntimePackageRoot(import.meta.dirname),
      "examples/models/default.config.json",
    ),
  );
  const buildProfile = (applyCreationTemperature: boolean) => ({
    ...buildModelConfig(
      template,
      String(provider.config.type),
      input.model,
      input.contextWindowTokens,
      input,
      undefined,
      applyCreationTemperature,
    ),
    provider: provider.id,
  });
  const profile = buildProfile(true);
  return {
    profile,
    matchesSaved(saved: Record<string, unknown>) {
      if (isDeepStrictEqual(saved, profile)) return true;
      // Profiles created before the sampling default must match that entire earlier shape.
      return isDeepStrictEqual(saved, buildProfile(false));
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
