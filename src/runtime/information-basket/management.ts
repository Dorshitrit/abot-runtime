import { randomUUID } from "node:crypto";
import type {
  BasketSettingsChange, BasketSourceRelink, BasketSourceRevision, InformationBasketOptions,
} from "./contracts.js";
import { InformationBasketError } from "./contracts.js";
import type { StoredBasketSource } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";
import { basketProfileSignature } from "./profile-binding.js";
import { requireBasketSource } from "./source-reading.js";
import { resolveBasketSourcePath } from "./source-reader.js";
import { isBasketRevision } from "./snapshot-validation.js";
import type { BasketStateOwner } from "./state-owner.js";

function sourcePathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
function requeueBasketSource(source: StoredBasketSource): StoredBasketSource {
  return { ...source, revision: source.revision + 1, status: "queued",
    index: null, chunkCount: 0, indexedAt: null, reason: null };
}
function hasBasketSourcePathConflict(sources: readonly StoredBasketSource[], sourceId: string, path: string): boolean {
  const key = sourcePathKey(path);
  for (const source of sources) {
    if (source.sourceId === sourceId) continue;
    if (sourcePathKey(source.path) === key) return true;
  }
  return false;
}
export function createBasketManagement(options: InformationBasketOptions & {
  state: BasketStateOwner;
  queue: Readonly<{ wake(): void; cancelSource(sourceId?: string): void }>;
}) {
  return {
    async updateSettings(input: BasketSettingsChange): Promise<void> {
      if (!isBasketRevision(input.expectedRevision) || typeof input.enabled !== "boolean")
        throw new InformationBasketError("basket_settings_invalid");
      if (input.embeddingProfileId !== null) {
        if (typeof input.embeddingProfileId !== "string" || !input.embeddingProfileId)
          throw new InformationBasketError("basket_settings_invalid");
        basketProfileSignature(options.config, input.embeddingProfileId);
      }
      await options.state.update(state => {
        if (state.settings.revision !== input.expectedRevision)
          throw new InformationBasketError("basket_settings_revision_conflict", undefined, 409);
        const profileChanged = state.settings.embeddingProfileId !== input.embeddingProfileId;
        options.queue.cancelSource();
        return {
          ...state,
          settings: { revision: state.settings.revision + 1, enabled: input.enabled, embeddingProfileId: input.embeddingProfileId },
          sources: state.sources.map(source => {
            if (profileChanged) return requeueBasketSource(source);
            if (source.status === "indexing") return requeueBasketSource(source);
            if (input.enabled && source.reason === "basket_index_cancelled") return requeueBasketSource(source);
            return source;
          }),
        };
      });
      options.queue.wake();
    },
    async addSources(input: Readonly<{ paths: readonly string[] }>): Promise<void> {
      if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > BASKET_LIMITS.maxSources)
        throw new InformationBasketError("basket_source_batch_invalid");
      const resolved: Awaited<ReturnType<typeof resolveBasketSourcePath>>[] = [];
      for (const path of input.paths) resolved.push(await resolveBasketSourcePath(path));
      await options.state.update(state => {
        const sources = [...state.sources];
        const existing = new Set(sources.map(source => sourcePathKey(source.path)));
        for (const source of resolved) {
          const key = sourcePathKey(source.path);
          if (existing.has(key)) continue;
          if (sources.length >= BASKET_LIMITS.maxSources)
            throw new InformationBasketError("basket_source_count_limit");
          sources.push({
            ...source, sourceId: "basket-" + randomUUID(), revision: 1,
            status: "queued", chunkCount: 0, indexedAt: null, reason: null, index: null,
          });
          existing.add(key);
        }
        return sources.length === state.sources.length ? state : { ...state, sources };
      });
      options.queue.wake();
    },
    async removeSource(input: BasketSourceRevision): Promise<void> {
      await options.state.update(state => {
        requireBasketSource(state, input);
        options.queue.cancelSource(input.sourceId);
        return { ...state, sources: state.sources.filter(source => source.sourceId !== input.sourceId) };
      });
    },
    async relinkSource(input: BasketSourceRelink): Promise<void> {
      const resolved = await resolveBasketSourcePath(input.path);
      await options.state.update(state => {
        const source = requireBasketSource(state, input);
        if (hasBasketSourcePathConflict(state.sources, source.sourceId, resolved.path))
          throw new InformationBasketError("basket_source_path_conflict", undefined, 409);
        options.queue.cancelSource(source.sourceId);
        const replacement = { ...requeueBasketSource(source), ...resolved };
        return { ...state, sources: state.sources.map(entry =>
          entry.sourceId === source.sourceId ? replacement : entry) };
      });
      options.queue.wake();
    },
    async refreshSource(input: BasketSourceRevision): Promise<void> {
      await options.state.update(state => {
        requireBasketSource(state, input);
        options.queue.cancelSource(input.sourceId);
        return { ...state, sources: state.sources.map(source =>
          source.sourceId === input.sourceId ? requeueBasketSource(source) : source) };
      });
      options.queue.wake();
    },
  };
}
