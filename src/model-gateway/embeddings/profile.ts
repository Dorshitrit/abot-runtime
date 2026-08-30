import type {
  ModelGatewayPolicyConfig,
  ResolvedEmbeddingProfile,
} from "../types.js";

export type EmbeddingProfileResolutionErrorCode =
  | "embedding_profile_required"
  | "unknown_embedding_profile"
  | "unknown_embedding_provider";

export class EmbeddingProfileResolutionError extends Error {
  readonly statusCode = 400;

  constructor(
    readonly code: EmbeddingProfileResolutionErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "EmbeddingProfileResolutionError";
  }
}

export function resolveEmbeddingProfile(params: {
  profileId: unknown;
  modelPolicy?: ModelGatewayPolicyConfig;
}): ResolvedEmbeddingProfile {
  const profileId = readRequiredProfileId(params.profileId);
  const configured = params.modelPolicy?.embeddingProfiles?.[profileId];
  if (!configured) {
    throw new EmbeddingProfileResolutionError(
      "unknown_embedding_profile",
      `embedding profile ${profileId} is not available in model policy`,
    );
  }
  const providerId = configured.provider.trim();
  const providerConfig = params.modelPolicy?.providers?.[providerId];
  if (!providerConfig) {
    throw new EmbeddingProfileResolutionError(
      "unknown_embedding_provider",
      `embedding profile ${profileId} references unavailable provider ${providerId}`,
    );
  }
  return Object.freeze({
    id: profileId,
    label: configured.label?.trim() || profileId,
    providerId,
    provider: providerConfig.type,
    providerConfig,
    model: configured.model.trim(),
    options: Object.freeze({ ...(configured.options ?? {}) }),
  });
}

function readRequiredProfileId(value: unknown): string {
  const profileId = typeof value === "string" ? value.trim() : "";
  if (profileId) {
    return profileId;
  }
  throw new EmbeddingProfileResolutionError(
    "embedding_profile_required",
    "profileId must identify a configured embedding profile",
  );
}
