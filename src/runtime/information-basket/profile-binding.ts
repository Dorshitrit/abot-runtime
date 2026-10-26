import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../ports.js";
import { InformationBasketError, type BasketEmbeddingProfile } from "./contracts.js";

function stableProfileValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProfileValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, stableProfileValue(entry)]));
}

export function listBasketEmbeddingProfiles(config: RuntimeConfig): readonly BasketEmbeddingProfile[] {
  return Object.freeze(Object.entries(config.models?.embeddingProfiles ?? {})
    .map(([id, profile]) => Object.freeze({
      id, label: profile.label ?? id, provider: profile.provider, model: profile.model,
    })));
}

export function basketProfileSignature(config: RuntimeConfig, profileId: string): string {
  const profile = config.models?.embeddingProfiles?.[profileId];
  if (!profile) throw new InformationBasketError("basket_embedding_profile_unavailable", undefined, 503);
  const provider = config.models?.providers?.[profile.provider];
  if (!provider) throw new InformationBasketError("basket_embedding_provider_unavailable", undefined, 503);
  return createHash("sha256").update(JSON.stringify(stableProfileValue({
    profileId, profile, provider, extraction: "basket-source-v1", chunking: "characters-1800-overlap-200-v1",
  }))).digest("hex");
}
