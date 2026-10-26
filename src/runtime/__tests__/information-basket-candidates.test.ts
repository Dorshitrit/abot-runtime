import { expect, test, vi } from "vitest";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
import type { BasketDiscoveryChange, BasketSearchResult } from "../information-basket/contracts.js";
import { createInformationBasketCandidateSource } from "../information-basket/request-candidates.js";
import { RequestToolResources } from "../capabilities/request-tool-resources.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";

const tools: readonly ToolAvailabilityEntry[] = ["search_information_sources", "read_information_source"].map((operationId) => ({
  toolName: "information_basket", operationId, summary: "Read basket", catalogGroups: ["knowledge"], effect: "read_only",
}));
const found: BasketSearchResult = { status: "found", omittedCount: 0, sources: [{
  sourceId: "basket-source", expectedRevision: 1, displayName: "Design", path: "/source.md", score: 0.8,
  matches: [{ chunkId: "chunk-0", startChar: 0, endChar: 20 }],
}] };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function fixture(available = tools) {
  const resources = new RequestToolResources();
  const steering = createRequestSteeringInbox({ requestId: "basket-request" });
  const abort = new AbortController();
  let changed = (_change: BasketDiscoveryChange) => {};
  const resolve: Array<(value: BasketSearchResult) => void> = [];
  const search = vi.fn((input: { query: string; abortSignal: AbortSignal }) =>
    new Promise<BasketSearchResult>((accept) => { resolve.push(accept); }));
  const unsubscribe = vi.fn();
  const onEvent = vi.fn();
  const source = createInformationBasketCandidateSource({
    request: { requestId: "basket-request", prompt: "  Original request  ", requestSteering: steering,
      abortSignal: abort.signal, toolResources: resources, onEvent },
    getAvailableTools: () => available,
    service: { search, subscribeChanges(listener) { changed = listener; return unsubscribe; } },
  });
  return { source, resources, steering, abort, search, resolve, onEvent, changed: (change: BasketDiscoveryChange = { settingsChanged: true, invalidatedSourceIds: [], readySourcesAdded: false }) => changed(change), unsubscribe };
}

test("speculative search does not hold request resources or publish unfinished results", async () => {
  const f = fixture();
  expect(f.source.getInformationBasketCandidates()).toBeUndefined();
  await flush();
  expect(f.search).toHaveBeenCalledTimes(1);
  expect(f.search.mock.calls[0]![0].query).toBe("  Original request  ");
  expect(f.resources.hasActiveWork()).toBe(false);
  expect(() => f.resources.snapshot()).not.toThrow();
  f.resolve[0]!(found);
  await flush();
  expect(f.onEvent).not.toHaveBeenCalled();
  expect(f.source.getInformationBasketCandidates(0)).toMatchObject({
    requestId: "basket-request", steeringVersion: 0, discoveryRevision: 0, result: found,
  });
  expect(f.onEvent).toHaveBeenCalledOnce();
  expect(f.onEvent).toHaveBeenCalledWith("runtime.state", {
    stage: "information_basket", phase: "discovery_found",
    message: "Found 1 relevant information basket source: Design.",
  });
  f.source.getInformationBasketCandidates(0);
  expect(f.onEvent).toHaveBeenCalledOnce();
  expect(f.steering.snapshot()).toEqual({ version: 0, updates: [] });
  await f.resources.dispose();
});

test("steering and index changes invalidate old results without rerunning the model", async () => {
  const f = fixture();
  await flush();
  f.steering.append({ steerId: "updated", text: "Use the newer topic" });
  f.resolve[0]!(found);
  await flush();
  expect(f.source.getInformationBasketCandidates(0)).toBeUndefined();
  expect(f.source.getInformationBasketCandidates(1)).toBeUndefined();
  await flush();
  expect(f.search).toHaveBeenCalledTimes(2);
  expect(JSON.parse(f.search.mock.calls[1]![0].query)).toEqual({
    originalRequest: "  Original request  ", laterUserMessages: [{ sequence: 1, text: "Use the newer topic" }],
  });
  f.changed();
  expect(f.search.mock.calls[1]![0].abortSignal.aborted).toBe(true);
  f.resolve[1]!(found);
  await flush();
  expect(f.source.getInformationBasketCandidates(1)).toBeUndefined();
  await f.resources.dispose();
});

test.each(["dispose", "cancel"] as const)("late results after %s never reappear", async (mode) => {
  const f = fixture();
  await flush();
  if (mode === "dispose") await f.resources.dispose(); else f.abort.abort();
  expect(f.search.mock.calls[0]![0].abortSignal.aborted).toBe(true);
  f.resolve[0]!(found);
  await flush();
  expect(f.source.getInformationBasketCandidates()).toBeUndefined();
  expect(f.onEvent).not.toHaveBeenCalled();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.resources.hasActiveWork()).toBe(false);
});

test.each([[], tools.slice(0, 1), tools.slice(1)].map((available) => ({ available })))("missing effective operations suppress search and metadata", async ({ available }) => {
  const f = fixture(available);
  await flush();
  expect(f.onEvent).not.toHaveBeenCalled();
  expect(f.search).not.toHaveBeenCalled();
  expect(f.source.getInformationBasketCandidates()).toBeUndefined();
  await f.resources.dispose();
});

test.each(["empty", "unavailable"] as const)("an %s result remains silent and is not repeatedly queried per invocation", async (status) => {
  const f = fixture();
  await flush();
  f.resolve[0]!({ status, sources: [], omittedCount: 0 });
  await flush();
  for (let i = 0; i < 3; i++) expect(f.source.getInformationBasketCandidates()).toBeUndefined();
  expect(f.onEvent).not.toHaveBeenCalled();
  expect(f.search).toHaveBeenCalledOnce();
  await f.resources.dispose();
});

test("unrelated queue progress and newly ready sources do not starve an unresolved lookup", async () => {
  const f = fixture();
  await flush();
  f.changed({ settingsChanged: false, invalidatedSourceIds: [], readySourcesAdded: false });
  f.changed({ settingsChanged: false, invalidatedSourceIds: [], readySourcesAdded: true });
  expect(f.search.mock.calls[0]![0].abortSignal.aborted).toBe(false);
  expect(f.source.getInformationBasketCandidates()).toBeUndefined();
  expect(f.search).toHaveBeenCalledOnce();
  f.resolve[0]!(found);
  await flush();
  expect(f.source.getInformationBasketCandidates()?.result).toEqual(found);
  expect(f.search).toHaveBeenCalledOnce();
  await f.resources.dispose();
});

test("affected sources are filtered from an in-flight result without losing unaffected sources", async () => {
  const f = fixture();
  await flush();
  f.changed({ settingsChanged: false, invalidatedSourceIds: ["basket-source"], readySourcesAdded: false });
  expect(f.search.mock.calls[0]![0].abortSignal.aborted).toBe(false);
  const unaffected = { ...found.sources[0]!, sourceId: "basket-unaffected" };
  f.resolve[0]!({ ...found, sources: [...found.sources, unaffected] });
  await flush();
  expect(f.source.getInformationBasketCandidates()?.result.sources).toEqual([unaffected]);
  f.changed({ settingsChanged: true, invalidatedSourceIds: [], readySourcesAdded: false });
  expect(f.search).toHaveBeenCalledOnce();
  expect(f.source.getInformationBasketCandidates()).toBeUndefined();
  await f.resources.dispose();
});

test("discovery presentation is deduplicated by intent and exact source revisions, not index progress", async () => {
  const f = fixture();
  await flush();
  f.resolve[0]!(found);
  await flush();
  f.source.getInformationBasketCandidates();
  f.changed({ settingsChanged: false, invalidatedSourceIds: [], readySourcesAdded: true });
  f.source.getInformationBasketCandidates();
  expect(f.onEvent).toHaveBeenCalledOnce();

  f.changed();
  f.source.getInformationBasketCandidates();
  await flush();
  f.resolve[1]!(found);
  await flush();
  f.source.getInformationBasketCandidates();
  expect(f.onEvent).toHaveBeenCalledOnce();

  f.changed();
  f.source.getInformationBasketCandidates();
  await flush();
  f.resolve[2]!({ ...found, sources: [{ ...found.sources[0]!, expectedRevision: 2 }] });
  await flush();
  expect(f.onEvent).toHaveBeenCalledOnce();
  f.source.getInformationBasketCandidates();
  expect(f.onEvent).toHaveBeenCalledTimes(2);

  f.steering.append({ steerId: "new", text: "Different intent" });
  expect(f.source.getInformationBasketCandidates(0)).toBeUndefined();
  f.source.getInformationBasketCandidates(1);
  await flush();
  f.resolve[3]!({ ...found, sources: [{ ...found.sources[0]!, expectedRevision: 2 }] });
  await flush();
  expect(f.onEvent).toHaveBeenCalledTimes(2);
  f.source.getInformationBasketCandidates(1);
  expect(f.onEvent).toHaveBeenCalledTimes(3);
  expect(f.resources.hasActiveWork()).toBe(false);
  await f.resources.dispose();
});

test("a settled result never publishes when the request finishes without another natural decision", async () => {
  const f = fixture();
  await flush();
  f.resolve[0]!(found);
  await flush();
  expect(f.steering.seal(0)).toBe(true);
  await f.resources.dispose();
  expect(f.onEvent).not.toHaveBeenCalled();
  expect(f.source.getInformationBasketCandidates()).toBeUndefined();
  expect(f.onEvent).not.toHaveBeenCalled();
});

test("closing the steering inbox suppresses a settled discovery before resource disposal", async () => {
  const f = fixture();
  await flush();
  f.resolve[0]!(found);
  await flush();
  await f.steering.close();
  expect(f.source.getInformationBasketCandidates()).toBeUndefined();
  expect(f.onEvent).not.toHaveBeenCalled();
  expect(f.search).toHaveBeenCalledOnce();
  await f.resources.dispose();
});

test.each(["pending", "settled"] as const)("invalidating every %s match does not restart optional search", async phase => {
  const f = fixture();
  await flush();
  if (phase === "settled") { f.resolve[0]!(found); await flush(); }
  f.changed({ settingsChanged: false, invalidatedSourceIds: ["basket-source"], readySourcesAdded: false });
  if (phase === "pending") { f.resolve[0]!(found); await flush(); }
  for (let i = 0; i < 20; i++) {
    expect(f.source.getInformationBasketCandidates()).toBeUndefined();
    await flush();
  }
  expect(f.search).toHaveBeenCalledOnce();
  expect(f.onEvent).not.toHaveBeenCalled();
  f.changed({ settingsChanged: false, invalidatedSourceIds: [], readySourcesAdded: true });
  f.source.getInformationBasketCandidates();
  await flush();
  expect(f.search).toHaveBeenCalledTimes(2);
  await f.resources.dispose();
});
