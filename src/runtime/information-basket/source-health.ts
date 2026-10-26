import { setImmediate } from "node:timers/promises";
import type { BasketSnapshot, StoredBasketSource } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";
import { readBasketFileIdentity } from "./source-identity.js";
import { basketIoFailure } from "./source-reader.js";
import type { BasketStateOwner } from "./state-owner.js";
import { createBasketMetadataPool } from "./source-health-pool.js";

type Inspection = Readonly<{
  source: StoredBasketSource;
  failure?: Readonly<{ status: "missing" | "stale"; reason: string }>;
}>;

export function hasReadyBasketFile(source: StoredBasketSource): boolean {
  return source.status === "ready" && source.index !== null;
}

export function hasSameBasketFileBinding(current: StoredBasketSource, inspected: StoredBasketSource): boolean {
  if (!hasReadyBasketFile(current)) return false;
  if (current.revision !== inspected.revision || current.path !== inspected.path) return false;
  return current.index!.fileIdentity === inspected.index!.fileIdentity
    && current.index!.contentHash === inspected.index!.contentHash;
}

function invalidateBasketFiles(
  state: BasketSnapshot, failures: ReadonlyMap<string, Inspection>, signal: AbortSignal,
): BasketSnapshot {
  if (signal.aborted) return state;
  let changed = false;
  const sources = state.sources.map(source => {
    const inspected = failures.get(source.sourceId);
    if (!inspected?.failure || !hasSameBasketFileBinding(source, inspected.source)) return source;
    changed = true;
    return { ...source, ...inspected.failure, index: null, chunkCount: 0 };
  });
  return changed ? { ...state, sources } : state;
}

/** One environment pool. Only in-flight metadata is retained; no positive-result or body cache. */
export function createBasketSourceHealth(options: {
  state: BasketStateOwner;
  readIdentity?: (path: string) => Promise<string>;
}) {
  const pool = createBasketMetadataPool(options.readIdentity ?? readBasketFileIdentity);

  async function inspect(source: StoredBasketSource, signal: AbortSignal): Promise<Inspection> {
    try {
      const binding = JSON.stringify([source.sourceId, source.revision,
        source.index!.fileIdentity, source.index!.contentHash]);
      const identity = await pool.read(binding, source.path, signal);
      if (identity === source.index!.fileIdentity) return { source };
      return { source, failure: { status: "stale", reason: "basket_source_changed" } };
    } catch (error) {
      signal.throwIfAborted();
      const code = basketIoFailure(error).code;
      if (code === "basket_source_not_found")
        return { source, failure: { status: "missing", reason: code } };
      return { source, failure: { status: "stale", reason: "basket_source_unavailable" } };
    }
  }

  return Object.freeze({
    async validate(sources: readonly StoredBasketSource[], callerSignal: AbortSignal): Promise<void> {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(BASKET_LIMITS.healthTimeoutMs)]);
      signal.throwIfAborted();
      const failures = new Map<string, Inspection>();
      let next = 0;
      const worker = async () => {
        while (next < sources.length) {
          signal.throwIfAborted();
          const source = sources[next++]!;
          if (!hasReadyBasketFile(source)) continue;
          const inspection = await inspect(source, signal);
          if (inspection.failure) failures.set(source.sourceId, inspection);
          // Yield even when an injected/cached filesystem resolves immediately.
          await setImmediate(undefined, { signal });
        }
      };
      await Promise.all(Array.from({ length: Math.min(sources.length, BASKET_LIMITS.healthConcurrency) }, worker));
      signal.throwIfAborted();
      if (!failures.size) return;
      // One canonical commit and notification for the batch, not one store rewrite per file.
      await options.state.update(state => invalidateBasketFiles(state, failures, signal));
      signal.throwIfAborted();
    },
  });
}

export type BasketSourceHealth = ReturnType<typeof createBasketSourceHealth>;
