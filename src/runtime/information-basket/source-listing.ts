import type { RuntimeConfig } from "../ports.js";
import type { InformationBasketService } from "./contracts.js";
import type { StoredBasketSource } from "./index-records.js";
import { projectBasketSource } from "./index-records.js";
import { BASKET_LIMITS, BASKET_SUPPORTED_EXTENSIONS } from "./limits.js";
import { listBasketEmbeddingProfiles } from "./profile-binding.js";
import type { createBasketServiceWork } from "./service-work.js";
import { hasReadyBasketFile, hasSameBasketFileBinding, type BasketSourceHealth } from "./source-health.js";
import type { BasketStateOwner } from "./state-owner.js";

function wasBasketSourceInspected(source: StoredBasketSource, inspected: ReadonlyMap<string, StoredBasketSource>): boolean {
  const binding = inspected.get(source.sourceId);
  if (!binding) return false;
  return hasSameBasketFileBinding(source, binding);
}

export function createBasketSourceListing(options: {
  config: RuntimeConfig; state: BasketStateOwner; health: BasketSourceHealth;
  work: ReturnType<typeof createBasketServiceWork>;
}): InformationBasketService["list"] {
  return async input => {
    let inspected: ReadonlyMap<string, StoredBasketSource> | undefined;
    if (input?.verifySources) inspected = await options.work.run(input.abortSignal, async signal => {
      const current = await options.state.read();
      if (!current.settings.enabled) return new Map<string, StoredBasketSource>();
      const sources = current.sources.filter(hasReadyBasketFile);
      await options.health.validate(sources, signal);
      return new Map(sources.map(source => [source.sourceId, source]));
    });
    const snapshot = await options.state.read();
    input?.abortSignal?.throwIfAborted();
    const bindings = inspected;
    const sources = bindings ? snapshot.sources.filter(source => wasBasketSourceInspected(source, bindings)) : snapshot.sources;
    return Object.freeze({
      settings: snapshot.settings, sources: Object.freeze(sources.map(projectBasketSource)),
      embeddingProfiles: listBasketEmbeddingProfiles(options.config),
      supportedExtensions: BASKET_SUPPORTED_EXTENSIONS,
      limits: Object.freeze({
        maxSources: BASKET_LIMITS.maxSources, maxSourceBytes: BASKET_LIMITS.maxSourceBytes,
        maxReadCharacters: BASKET_LIMITS.maxReadCharacters,
      }),
    });
  };
}
