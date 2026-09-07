import type { RuntimeConfigFile } from "../../config/types.js";
import { isRecord } from "../../config/utils.js";
import type {
  LongTermMemoryOnboardingProvider,
  LongTermMemoryOnboardingStatus,
} from "./contracts.js";

export const DEFAULT_MEMORY_EMBEDDING_PROFILE_ID = "memory-embedding";

export function projectOnboardingStatus(
  config: RuntimeConfigFile,
): LongTermMemoryOnboardingStatus {
  const memory = isRecord(config.longTermMemory) ? config.longTermMemory : {};
  const profileId = readText(memory.embeddingProfileId);
  const embeddingProfiles = readEmbeddingProfiles(config);
  const profile = profileId ? embeddingProfiles[profileId] : undefined;
  const providerId = isRecord(profile) ? readText(profile.provider) : undefined;
  const model = isRecord(profile) ? readText(profile.model) : undefined;
  return Object.freeze({
    enabled: memory.enabled === true,
    emitClientEvents: memory.emitClientEvents === true,
    providers: listConfiguredProviders(config),
    ...(profileId ? { profileId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
  });
}

export function buildEnabledMemoryConfig(params: {
  config: RuntimeConfigFile;
  providerId: string;
  model: string;
  profileId: string;
  emitClientEvents: boolean;
}): RuntimeConfigFile {
  const models = isRecord(params.config.models) ? params.config.models : {};
  const memory = isRecord(params.config.longTermMemory)
    ? params.config.longTermMemory
    : {};
  const profiles = readEmbeddingProfiles(params.config);
  const existingProfile = profiles[params.profileId];
  const existingOptions = readMatchingProfileOptions({
    profile: existingProfile,
    providerId: params.providerId,
    model: params.model,
  });
  return {
    ...params.config,
    models: {
      ...models,
      embeddingProfiles: {
        ...profiles,
        [params.profileId]: {
          label: "Long-term memory embeddings",
          provider: params.providerId,
          model: params.model,
          ...(existingOptions ? { options: existingOptions } : {}),
        },
      },
    },
    longTermMemory: {
      enabled: true,
      emitClientEvents: params.emitClientEvents,
      embeddingProfileId: params.profileId,
      ...(memory.maxRecallCallsPerRequest === undefined
        ? {}
        : { maxRecallCallsPerRequest: memory.maxRecallCallsPerRequest }),
    },
  };
}

function readMatchingProfileOptions(params: {
  profile: unknown;
  providerId: string;
  model: string;
}): Record<string, unknown> | undefined {
  if (!isRecord(params.profile)) {
    return undefined;
  }
  const targetsMatchExactly =
    params.profile.provider === params.providerId &&
    params.profile.model === params.model;
  if (!targetsMatchExactly || !isRecord(params.profile.options)) {
    return undefined;
  }
  return params.profile.options;
}

export function buildDisabledMemoryConfig(
  config: RuntimeConfigFile,
): RuntimeConfigFile {
  const current = isRecord(config.longTermMemory) ? config.longTermMemory : {};
  return {
    ...config,
    longTermMemory: {
      ...current,
      enabled: false,
    },
  };
}

export function listConfiguredProviders(
  config: RuntimeConfigFile,
): readonly LongTermMemoryOnboardingProvider[] {
  const models = isRecord(config.models) ? config.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  return Object.freeze(
    Object.entries(providers)
      .flatMap(([id, value]) => {
        const type = isRecord(value) ? readText(value.type) : undefined;
        return type ? [{ id, type }] : [];
      })
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function requireConfiguredProvider(
  config: RuntimeConfigFile,
  providerId: string,
): void {
  const found = listConfiguredProviders(config).some(
    (provider) => provider.id === providerId,
  );
  if (!found) {
    throw new Error(`long_term_memory_provider_not_configured:${providerId}`);
  }
}

function readEmbeddingProfiles(
  config: RuntimeConfigFile,
): Record<string, unknown> {
  const models = isRecord(config.models) ? config.models : {};
  return isRecord(models.embeddingProfiles) ? models.embeddingProfiles : {};
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
