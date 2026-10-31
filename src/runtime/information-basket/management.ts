import type {
  BasketSettingsChange, BasketSourceRelink, BasketSourceRevision, InformationBasketOptions,
} from "./contracts.js";
import { InformationBasketError } from "./contracts.js";
import type { StoredBasketSource } from "./index-records.js";
import { basketSourcePathKey, createBasketSourceRegistration } from "./source-registration.js";
import { basketProfileSignature } from "./profile-binding.js";
import { requireBasketSource } from "./source-reading.js";
import { resolveBasketSourcePath } from "./source-reader.js";
import { isBasketMatchMode, isBasketRevision } from "./snapshot-validation.js";
import type { BasketStateOwner } from "./state-owner.js";

function requeueBasketSource(source: StoredBasketSource): StoredBasketSource {
  return { ...source, revision: source.revision + 1, status: "queued",
    index: null, chunkCount: 0, indexedAt: null, reason: null };
}
function hasBasketSourcePathConflict(sources: readonly StoredBasketSource[], sourceId: string, path: string): boolean {
  const key = basketSourcePathKey(path);
  for (const source of sources) {
    if (source.sourceId === sourceId) continue;
    if (basketSourcePathKey(source.path) === key) return true;
  }
  return false;
}
export function createBasketManagement(options: InformationBasketOptions & {
  state: BasketStateOwner;
  queue: Readonly<{ wake(): void; cancelSource(sourceId?: string): void }>;
}) {
  const register = createBasketSourceRegistration(options.state, options.queue.wake);
  return {
    register,
    async updateSettings(input: BasketSettingsChange): Promise<void> {
      if (!isBasketRevision(input.expectedRevision) || typeof input.enabled !== "boolean")
        throw new InformationBasketError("basket_settings_invalid");
      if (input.indexChatUploads !== undefined && typeof input.indexChatUploads !== "boolean")
        throw new InformationBasketError("basket_settings_invalid");
      if (input.matchMode !== undefined && !isBasketMatchMode(input.matchMode))
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
        const indexingChanged = profileChanged || state.settings.enabled !== input.enabled;
        if (indexingChanged) options.queue.cancelSource();
        return {
          ...state,
          settings: { revision: state.settings.revision + 1, enabled: input.enabled, embeddingProfileId: input.embeddingProfileId,
            indexChatUploads: input.indexChatUploads ?? state.settings.indexChatUploads,
            matchMode: input.matchMode ?? state.settings.matchMode },
          sources: state.sources.map(source => {
            if (!indexingChanged) return source;
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
      if (!Array.isArray(input.paths)) throw new InformationBasketError("basket_source_batch_invalid");
      await register(input.paths.map(path => ({ path })));
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
