import type { InformationBasketOptions } from "./contracts.js";
import { InformationBasketError } from "./contracts.js";
import { buildBasketSourceIndex } from "./index-builder.js";
import type { BasketSnapshot, BasketSourceReader, StoredBasketSource } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";
import { basketProfileSignature } from "./profile-binding.js";
import type { BasketStateOwner } from "./state-owner.js";

function canIndexQueuedSource(state: BasketSnapshot, source: StoredBasketSource, profileId: string): boolean {
  if (!state.settings.enabled || state.settings.embeddingProfileId !== profileId) return false;
  return state.sources.some(current => current.sourceId === source.sourceId
    && current.revision === source.revision && current.status === "queued");
}
function canCommitBasketIndex(state: BasketSnapshot, source: StoredBasketSource, profileId: string): boolean {
  if (!state.settings.enabled || state.settings.embeddingProfileId !== profileId) return false;
  return state.sources.some(current => current.sourceId === source.sourceId
    && current.revision === source.revision && current.status === "indexing");
}
function updateSource(state: BasketSnapshot, sourceId: string, update: (source: StoredBasketSource) => StoredBasketSource): BasketSnapshot {
  return { ...state, sources: state.sources.map(source => source.sourceId === sourceId ? update(source) : source) };
}
function indexFailureStatus(code: string): StoredBasketSource["status"] {
  if (code === "basket_source_not_found") return "missing";
  if (code === "basket_source_format_unsupported") return "unsupported";
  if (code.includes("changed_during")) return "stale";
  return "failed";
}

type BasketIndexJob = { sourceId?: string; controller: AbortController; promise: Promise<void> };

export function createBasketIndexQueue(options: InformationBasketOptions & {
  state: BasketStateOwner; reader: BasketSourceReader;
}) {
  let running = false;
  let active: BasketIndexJob | undefined;
  async function runNext(job: { sourceId?: string; controller: AbortController }): Promise<boolean> {
    const snapshot = await options.state.read();
    const profileId = snapshot.settings.embeddingProfileId;
    if (!running || !snapshot.settings.enabled || !profileId || job.controller.signal.aborted) return false;
    const source = snapshot.sources.find(entry => entry.status === "queued");
    if (!source) return false;
    job.sourceId = source.sourceId;
    const timeout = setTimeout(() => job.controller.abort(new InformationBasketError("basket_index_timeout")),
      BASKET_LIMITS.indexTimeoutMs);
    timeout.unref();
    try {
      basketProfileSignature(options.config, profileId);
      const started = await options.state.update(state => {
        if (!canIndexQueuedSource(state, source, profileId) || job.controller.signal.aborted) return state;
        return updateSource(state, source.sourceId, current => ({ ...current, status: "indexing", reason: null }));
      });
      if (!canCommitBasketIndex(started, source, profileId)) return true;
      const result = await buildBasketSourceIndex({
        ...options, profileId, path: source.path, abortSignal: job.controller.signal,
      });
      await options.state.update(state => {
        if (!running || job.controller.signal.aborted || !canCommitBasketIndex(state, source, profileId)) return state;
        return updateSource(state, source.sourceId, current => ({
          ...current, index: result.index, sizeBytes: result.sizeBytes,
          chunkCount: result.index.chunks.length, indexedAt: new Date().toISOString(), status: "ready", reason: null,
        }));
      });
    } catch (error) {
      const reason = error instanceof InformationBasketError ? error.code : "basket_index_failed";
      const cancelled = job.controller.signal.aborted;
      await options.state.update(state => {
        const current = state.sources.find(entry => entry.sourceId === source.sourceId);
        if (!current || current.revision !== source.revision) return state;
        if (current.status !== "queued" && current.status !== "indexing") return state;
        return updateSource(state, source.sourceId, entry => ({
          ...entry, index: null, chunkCount: 0,
          status: cancelled && !running ? "queued" : indexFailureStatus(reason),
          reason: cancelled ? "basket_index_cancelled" : reason,
        }));
      });
    } finally { clearTimeout(timeout); }
    return true;
  }
  const wake = () => {
    if (!running || active) return;
    const job: BasketIndexJob = { controller: new AbortController(), promise: Promise.resolve() };
    active = job;
    let processed = false;
    job.promise = runNext(job).then(value => { processed = value; }).catch(() => undefined).finally(() => {
      if (active === job) active = undefined;
      if (processed && running) wake();
    });
  };
  return Object.freeze({
    wake,
    cancelSource(sourceId?: string) {
      if (sourceId && active?.sourceId !== sourceId) return;
      active?.controller.abort(new InformationBasketError("basket_index_cancelled"));
    },
    async start() {
      if (running) return;
      running = true;
      try {
        await options.state.update(state => {
          const profileId = state.settings.embeddingProfileId;
          const profileExists = profileId && options.config.models?.embeddingProfiles?.[profileId];
          const signature = profileExists ? basketProfileSignature(options.config, profileId) : null;
          let changed = false;
          const sources = state.sources.map(source => {
            if (source.status === "indexing") {
              changed = true;
              return { ...source, status: "queued" as const, reason: "basket_index_interrupted" };
            }
            if (!source.index || source.index.profileSignature === signature) return source;
            changed = true;
            return { ...source, revision: source.revision + 1, status: "queued" as const,
              index: null, chunkCount: 0, reason: "basket_embedding_profile_changed" };
          });
          return changed ? { ...state, sources } : state;
        });
        wake();
      } catch (error) { running = false; throw error; }
    },
    async stop() {
      running = false;
      active?.controller.abort(new InformationBasketError("basket_index_cancelled"));
      await active?.promise;
    },
  });
}
