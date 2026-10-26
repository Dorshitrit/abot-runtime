import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { RequestCapabilityCompositionView } from "../request/execution-scope.js";
import { resolveRequestSteeringInbox, type RequestSteeringSnapshot } from "../request/request-steering.js";
import { emitBasketDiscovery } from "./presentation.js";
import type { BasketDiscoveryChange, BasketSearchResult, InformationBasketService } from "./contracts.js";

export type RequestBasketCandidates = Readonly<{
  requestId: string;
  steeringVersion: number;
  discoveryRevision: number;
  result: BasketSearchResult;
}>;

export interface InformationBasketCandidateSource {
  getInformationBasketCandidates(steeringVersion?: number): RequestBasketCandidates | undefined;
}

type CandidateRequest = Pick<RequestCapabilityCompositionView,
  "requestId" | "prompt" | "requestSteering" | "abortSignal" | "toolResources" | "onEvent">;

/** Optional metadata lives only in this request segment, outside history and checkpoints. */
export function createInformationBasketCandidateSource(params: Readonly<{
  request: CandidateRequest;
  service?: Pick<InformationBasketService, "search" | "subscribeChanges">;
  getAvailableTools(): readonly ToolAvailabilityEntry[];
}>): InformationBasketCandidateSource {
  const { request, service } = params;
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  let closed = false;
  let discoveryRevision = 0;
  let searchRevision = 0;
  let attemptedBinding: string | undefined;
  const presentedBindings = new Set<string>();
  let running: { controller: AbortController; version: number; invalidatedSourceIds: Set<string> } | undefined;
  let ready: RequestBasketCandidates | undefined;
  let unsubscribe: (() => void) | undefined;

  function invalidate(): void {
    discoveryRevision += 1;
    searchRevision += 1;
    ready = undefined;
    attemptedBinding = undefined;
    running?.controller.abort();
    running = undefined;
  }

  function changed(change: BasketDiscoveryChange): void {
    if (change.settingsChanged) { invalidate(); return; }
    if (!change.readySourcesAdded && change.invalidatedSourceIds.length === 0) return;
    discoveryRevision += 1;
    if (change.readySourcesAdded) searchRevision += 1;
    for (const sourceId of change.invalidatedSourceIds) running?.invalidatedSourceIds.add(sourceId);
    if (ready) {
      const invalidated = new Set(change.invalidatedSourceIds);
      const sources = ready.result.sources.filter(source => !invalidated.has(source.sourceId));
      ready = sources.length ? Object.freeze({ ...ready, discoveryRevision,
        result: Object.freeze({ ...ready.result, sources: Object.freeze(sources) }) }) : undefined;
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    invalidate();
    unsubscribe?.();
    request.abortSignal.removeEventListener("abort", close);
  }

  function canDiscover(): boolean {
    if (closed || request.abortSignal.aborted || !service) return false;
    return hasInformationBasketReadAccess(params.getAvailableTools());
  }

  function isSearchCurrent(version: number, controller: AbortController): boolean {
    if (closed || controller.signal.aborted || running?.controller !== controller) return false;
    return steering.isCurrent(version);
  }

  function refresh(snapshot: RequestSteeringSnapshot): void {
    if (!canDiscover()) return;
    if (ready?.steeringVersion === snapshot.version) return;
    if (running?.version === snapshot.version) return;
    const binding = JSON.stringify([snapshot.version, searchRevision]);
    if (binding === attemptedBinding) return;
    attemptedBinding = binding;
    ready = undefined;
    running?.controller.abort();
    const controller = new AbortController();
    const invalidatedSourceIds = new Set<string>();
    running = { controller, version: snapshot.version, invalidatedSourceIds };
    // No await, work tracking, callbacks into the root, or speculative source reads.
    void Promise.resolve().then(() => {
      if (!isSearchCurrent(snapshot.version, controller)) return undefined;
      return service!.search({
        query: basketIntentQuery(request.prompt, snapshot),
        abortSignal: controller.signal,
        maxSources: 5,
        includeExcerpts: false,
      });
    }).then((result) => {
      if (!result || !isSearchCurrent(snapshot.version, controller)) return;
      if (result.status !== "found" || result.sources.length === 0) return;
      if (result.sources.every(source => invalidatedSourceIds.has(source.sourceId))) return;
      ready = Object.freeze({
        requestId: request.requestId,
        steeringVersion: snapshot.version,
        discoveryRevision,
        result: Object.freeze({
          ...result,
          sources: Object.freeze(result.sources.filter(source => !invalidatedSourceIds.has(source.sourceId)).map((source) => Object.freeze({
            ...source,
            matches: Object.freeze(source.matches.map((match) => Object.freeze({ ...match }))),
          }))),
        }),
      });
    }).catch(() => {
      // Explicit tool search reports errors; optional discovery never fails the request.
    }).finally(() => {
      if (running?.controller === controller) running = undefined;
    });
  }

  if (service && !request.abortSignal.aborted) {
    unsubscribe = service.subscribeChanges(changed);
    request.abortSignal.addEventListener("abort", close, { once: true });
    request.toolResources?.onRequestDispose(close);
    refresh(steering.snapshot());
  }

  return Object.freeze({
    getInformationBasketCandidates(steeringVersion?: number) {
      if (!canDiscover()) return undefined;
      const snapshot = steering.snapshot();
      if (!steering.isCurrent(snapshot.version)) return undefined;
      if (steeringVersion !== undefined && steeringVersion !== snapshot.version) return undefined;
      refresh(snapshot);
      if (ready?.steeringVersion !== snapshot.version) return undefined;
      // Consume optional results only at an existing root decision; promise settlement never emits.
      const presentationBinding = JSON.stringify([snapshot.version,
        ready.result.sources.map(source => [source.sourceId, source.expectedRevision])]);
      if (!presentedBindings.has(presentationBinding)) {
        presentedBindings.add(presentationBinding);
        emitBasketDiscovery(request, ready.result);
      }
      return ready;
    },
  });
}

/** Discovery cannot expose source metadata if either source search or reading is denied. */
export function hasInformationBasketReadAccess(tools: readonly ToolAvailabilityEntry[]): boolean {
  const operations = new Set(tools.filter(({ toolName }) => toolName === "information_basket")
    .map(({ operationId }) => operationId));
  if (!operations.has("search_information_sources")) return false;
  return operations.has("read_information_source");
}

function basketIntentQuery(prompt: string, snapshot: RequestSteeringSnapshot): string {
  if (snapshot.updates.length === 0) return prompt;
  return JSON.stringify({
    originalRequest: prompt,
    laterUserMessages: snapshot.updates.map(({ sequence, text }) => ({ sequence, text })),
  });
}
