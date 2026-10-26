import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";
import type { BasketSource } from "./contracts.js";
import type { BasketSnapshot, StoredBasketSource } from "./index-records.js";
import { basketProfileSignature } from "./profile-binding.js";

export function isBasketSourceReady(source: Pick<BasketSource, "status">): boolean {
  return source.status === "ready";
}

function hasCompatibleReadyBasketIndex(source: StoredBasketSource, signature: string): boolean {
  if (!isBasketSourceReady(source) || !source.index) return false;
  if (source.index.profileSignature !== signature) return false;
  if (source.index.chunkingVersion !== 1) return false;
  return source.index.chunks.length > 0;
}

/** Local capability readiness, independent of query matches or provider health. */
export function isBasketRetrievalReady(params: Readonly<{
  snapshot: BasketSnapshot | undefined;
  config: RuntimeConfig;
  models: Pick<ModelGatewayClient, "embed">;
  started: boolean;
}>): boolean {
  if (!params.started || !params.snapshot) return false;
  if (!params.snapshot.settings.enabled) return false;
  if (typeof params.models.embed !== "function") return false;
  const profileId = params.snapshot.settings.embeddingProfileId;
  if (!profileId) return false;
  const profile = params.config.models?.embeddingProfiles?.[profileId];
  if (typeof profile?.model !== "string" || !profile.model.trim()) return false;
  let signature: string;
  try { signature = basketProfileSignature(params.config, profileId); }
  catch { return false; }
  return params.snapshot.sources.some(source => hasCompatibleReadyBasketIndex(source, signature));
}
