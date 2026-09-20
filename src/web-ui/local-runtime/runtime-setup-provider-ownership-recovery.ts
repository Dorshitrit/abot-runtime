import { isDeepStrictEqual } from "node:util";
import { canonicalConfigFilePath } from "../../runtime/adapters/config-file-transaction.js";
import type { InspectedRuntimeConfigFile } from "../../runtime/config/loader.js";
import { isRecord } from "../../runtime/config/utils.js";
import {
  setupConfigMap,
  type RuntimeSetupDraft,
} from "./runtime-setup-draft.js";

function providerStillMatchesReceipt(
  providers: Record<string, unknown>,
  providerId: string,
  ownedProvider: unknown,
): boolean {
  if (!Object.hasOwn(providers, providerId)) return false;
  if (!isRecord(ownedProvider)) return false;
  return isDeepStrictEqual(providers[providerId], ownedProvider);
}

/** A stale model receipt retains ownership only of unchanged providers at its canonical target. */
export async function recoverSetupProviderOwnership(
  source: InspectedRuntimeConfigFile,
  draft?: RuntimeSetupDraft,
  configPath = source.path,
): Promise<Record<string, unknown>> {
  if (!draft) return {};
  if ((await canonicalConfigFilePath(source.path)) !== draft.configPath)
    return {};
  if ((await canonicalConfigFilePath(configPath)) !== draft.configPath)
    return {};
  const models = setupConfigMap(source.config.models);
  const providers = setupConfigMap(models.providers);
  return Object.fromEntries(
    Object.entries(draft.ownedProviders).filter(([providerId, provider]) =>
      providerStillMatchesReceipt(providers, providerId, provider),
    ),
  );
}
