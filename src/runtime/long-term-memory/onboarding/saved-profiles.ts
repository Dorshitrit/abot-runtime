import { randomUUID } from "node:crypto";
import type { RuntimeConfigFile } from "../../config/types.js";
import { isRecord } from "../../config/utils.js";
import type { SavedMemoryEmbeddingProfile } from "./contracts.js";

export function readSavedEmbeddingProfiles(config: RuntimeConfigFile): Record<string, unknown> {
  const models = isRecord(config.models) ? config.models : {};
  return isRecord(models.embeddingProfiles) ? models.embeddingProfiles : {};
}

export function listSavedEmbeddingProfiles(config: RuntimeConfigFile): readonly SavedMemoryEmbeddingProfile[] {
  return Object.freeze(Object.entries(readSavedEmbeddingProfiles(config)).flatMap(([id, profile]) => {
    if (!isRecord(profile)) return [];
    if (typeof profile.provider !== "string") return [];
    if (typeof profile.model !== "string") return [];
    return [Object.freeze({
      id,
      label: typeof profile.label === "string" ? profile.label : id,
      providerId: profile.provider,
      model: profile.model,
    })];
  }));
}

/** A saved choice is independent of the active memory binding and credentials. */
export function buildSavedEmbeddingProfile(params: {
  config: RuntimeConfigFile;
  providerId: string;
  model: string;
  label: string;
}): { config: RuntimeConfigFile; profileId: string } {
  const models = isRecord(params.config.models) ? params.config.models : {};
  const profiles = readSavedEmbeddingProfiles(params.config);
  const profileId = `embedding-${randomUUID()}`;
  return {
    profileId,
    config: {
      ...params.config,
      models: {
        ...models,
        embeddingProfiles: {
          ...profiles,
          [profileId]: { label: params.label, provider: params.providerId, model: params.model },
        },
      },
    },
  };
}

export function matchingEmbeddingProfileLabel(profile: unknown, providerId: string, model: string): string | undefined {
  if (!isRecord(profile)) return undefined;
  if (profile.provider !== providerId) return undefined;
  if (profile.model !== model) return undefined;
  return typeof profile.label === "string" ? profile.label : undefined;
}

class SavedEmbeddingProfileRemovalError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

function hasConfiguredMemoryProfile(config: RuntimeConfigFile, profileId: string): boolean {
  if (!isRecord(config.longTermMemory)) return false;
  const selected = config.longTermMemory.embeddingProfileId;
  return typeof selected === "string" && selected.trim() === profileId;
}

function requireRemovableSavedProfile(config: RuntimeConfigFile, profileId: string): void {
  if (!Object.hasOwn(readSavedEmbeddingProfiles(config), profileId))
    throw new SavedEmbeddingProfileRemovalError("The saved embedding profile no longer exists.", 404);
  if (hasConfiguredMemoryProfile(config, profileId))
    throw new SavedEmbeddingProfileRemovalError("Choose another memory profile before removing this one.", 409);
}

/** Remove a saved choice, never its provider or stored memory data. */
export function buildRemovedEmbeddingProfile(config: RuntimeConfigFile, profileId: string): RuntimeConfigFile {
  requireRemovableSavedProfile(config, profileId);
  const models = isRecord(config.models) ? config.models : {};
  const profiles = { ...readSavedEmbeddingProfiles(config) };
  delete profiles[profileId];
  return { ...config, models: { ...models, embeddingProfiles: profiles } };
}
