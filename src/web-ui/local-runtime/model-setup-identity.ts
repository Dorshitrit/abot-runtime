import { join } from "node:path";
import {
  buildModelConfig,
  readJsonObject,
  resolveRuntimePackageRoot,
} from "../../../scripts/runtime-setup-files.js";
import type { ModelSetupInput } from "./model-setup-input.js";
import type { planModelProvider } from "./model-setup-provider.js";

type ModelProviderPlan = ReturnType<typeof planModelProvider>;

export async function buildModelSetupProfile(
  provider: ModelProviderPlan,
  input: ModelSetupInput,
) {
  const template = await readJsonObject(
    join(
      resolveRuntimePackageRoot(import.meta.dirname),
      "examples/models/default.config.json",
    ),
  );
  return {
    ...buildModelConfig(
      template,
      String(provider.config.type),
      input.model,
      input.contextWindowTokens,
    ),
    provider: provider.id,
  };
}

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
