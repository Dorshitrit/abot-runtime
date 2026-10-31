import { randomUUID } from "node:crypto";
import { InformationBasketError } from "./contracts.js";
import type { BasketSnapshot } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";
import { resolveBasketSourcePath } from "./source-reader.js";
import type { BasketStateOwner } from "./state-owner.js";

export function basketSourcePathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** One registration transaction for explicit paths and opted-in chat uploads. */
export function createBasketSourceRegistration(state: BasketStateOwner, wake: () => void) {
  return async (entries: readonly Readonly<{ path: string; displayName?: string }>[],
    canRegister: (snapshot: BasketSnapshot) => boolean = () => true): Promise<void> => {
    if (!entries.length || entries.length > BASKET_LIMITS.maxSources)
      throw new InformationBasketError("basket_source_batch_invalid");
    const resolved: Awaited<ReturnType<typeof resolveBasketSourcePath>>[] = [];
    for (const entry of entries) {
      const source = await resolveBasketSourcePath(entry.path);
      resolved.push({ ...source, displayName: entry.displayName?.trim().slice(0, 4096) || source.displayName });
    }
    await state.update(snapshot => {
      if (!canRegister(snapshot)) return snapshot;
      const sources = [...snapshot.sources];
      const existing = new Set(sources.map(source => basketSourcePathKey(source.path)));
      for (const source of resolved) {
        const key = basketSourcePathKey(source.path);
        if (existing.has(key)) continue;
        if (sources.length >= BASKET_LIMITS.maxSources)
          throw new InformationBasketError("basket_source_count_limit");
        sources.push({ ...source, sourceId: "basket-" + randomUUID(), revision: 1,
          status: "queued", chunkCount: 0, indexedAt: null, reason: null, index: null });
        existing.add(key);
      }
      return sources.length === snapshot.sources.length ? snapshot : { ...snapshot, sources };
    });
    wake();
  };
}
