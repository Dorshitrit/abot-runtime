import type { BasketDiscoveryChange } from "./contracts.js";
import type { BasketSnapshot, StoredBasketSource } from "./index-records.js";

function retainsReadyBasketBinding(previous: StoredBasketSource, next: StoredBasketSource | undefined): boolean {
  if (previous.status !== "ready" || !previous.index) return false;
  if (!next || next.status !== "ready" || !next.index) return false;
  if (previous.revision !== next.revision) return false;
  if (previous.index.contentHash !== next.index.contentHash) return false;
  if (previous.index.fileIdentity !== next.index.fileIdentity) return false;
  if (previous.index.profileSignature !== next.index.profileSignature) return false;
  if (previous.index.modelFingerprint !== next.index.modelFingerprint) return false;
  if (previous.index.dimensions !== next.index.dimensions) return false;
  return previous.index.chunkingVersion === next.index.chunkingVersion;
}

/** UI sees every commit; discovery consumers invalidate only changed ready bindings. */
export function basketDiscoveryChange(previous: BasketSnapshot, next: BasketSnapshot): BasketDiscoveryChange {
  const previousById = new Map(previous.sources.map(source => [source.sourceId, source]));
  const nextById = new Map(next.sources.map(source => [source.sourceId, source]));
  const invalidatedSourceIds = previous.sources.filter(source =>
    source.status === "ready" && !retainsReadyBasketBinding(source, nextById.get(source.sourceId)),
  ).map(source => source.sourceId);
  const readySourcesAdded = next.sources.some(source => {
    if (source.status !== "ready") return false;
    const before = previousById.get(source.sourceId);
    return !before || !retainsReadyBasketBinding(before, source);
  });
  return Object.freeze({
    settingsChanged: previous.settings.revision !== next.settings.revision,
    invalidatedSourceIds: Object.freeze(invalidatedSourceIds), readySourcesAdded,
  });
}
