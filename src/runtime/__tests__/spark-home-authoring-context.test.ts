import { expect, test, vi } from "vitest";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { SessionSnapshot, SessionListItem } from "../../sessions/types.js";
import type { BasketSource, BasketView, InformationBasketService } from "../information-basket/contracts.js";
import type { LongTermMemoryRecord } from "../long-term-memory/contracts.js";
import type { LearningCandidateRecord } from "../long-term-memory/maturation/contracts.js";
import { createSparkHomeAuthoringContextProvider, type AuthoringContextDependencies } from "../spark-home/authoring-context/index.js";
import { AUTHORING_CONTEXT_LIMITS as limits } from "../spark-home/authoring-context/contracts.js";
import { SPARK_HOME_MAX_HTML_BYTES } from "../spark-home/contracts.js";
import { readSparkHomeReference } from "./support/spark-home-reference.js";

const now = "2026-11-01T12:00:00.000Z";
const saved: LongTermMemoryRecord = {
  id: "saved-1", content: "Saved preference", tags: [], provenance: { kind: "manual", source: "web_ui" },
  createdAt: now, updatedAt: now,
};
const passive: LongTermMemoryRecord = {
  ...saved, id: "passive-1", content: "Passive learned preference",
  provenance: { kind: "passive_observation", environmentId: "environment-A", deviceId: "device-A", batchId: "batch-A",
    observationIds: ["observation-A"], observedAt: now, reason: "Repeated observation", certainty: "observed" },
};
const candidate: LearningCandidateRecord = {
  id: "candidate-1", revision: 2, content: "Tentative preference", tags: [], score: 1,
  reason: "One observation", certainty: "inferred", sources: [passive.provenance as Extract<LongTermMemoryRecord["provenance"], { kind: "passive_observation" }>],
  createdAt: now, updatedAt: now, lastReinforcedAt: now, expiresAt: "2026-11-03T12:00:00.000Z", reconsiderAt: null,
  embedding: { memoryId: "candidate-1", modelFingerprint: "MUST_NOT_PROJECT_VECTOR", dimensions: 2, vector: [91, 92] },
};
const resource: BasketSource = {
  sourceId: "registered-1", revision: 4, displayName: "Planning notes", path: "/registered/plan.txt",
  status: "ready", sizeBytes: 9000, chunkCount: 3, indexedAt: now, reason: null,
};

function conversation(sessionId: string): SessionSnapshot {
  const origin = { cronJobId: null, cronTitle: null, triggerType: null };
  return {
    sessionId, title: `Conversation ${sessionId}`, ...(sessionId === SPARK_SESSION_ID ? { kind: "spark" as const } : {}),
    messages: [
      { ...origin, id: "old-user", sessionId, role: "user", text: "Earlier interest", source: "user", createdAt: 1, requestId: "prior-request" },
      { ...origin, id: "old-answer", sessionId, role: "assistant", text: "Earlier answer", source: "request", createdAt: 2, requestId: "prior-request" },
      { ...origin, id: "current", sessionId, role: "user", text: "CURRENT_REQUEST_MUST_NOT_DUPLICATE", source: "user", createdAt: 3, requestId: "current-request" },
    ], requests: [], nextCursor: null,
  };
}

function fixture() {
  const records = [saved, passive];
  const status = vi.fn(async () => ({ enabled: true, available: true, recordCount: records.length, indexedRecordCount: 2 }));
  const list = vi.fn<AuthoringContextDependencies["memory"]["list"]>(async input => {
    const source = input?.origin ? records.filter(record => record.provenance.kind === "passive_observation") : records;
    return { items: source.slice(input?.offset ?? 0, (input?.offset ?? 0) + (input?.limit ?? 100)), total: source.length };
  });
  const learningList = vi.fn(async () => [candidate]);
  const memory = { enabled: true, status, list, learning: { list: learningList } } as AuthoringContextDependencies["memory"];
  const sessions = {
    listSessions: vi.fn(async () => ({ sessions: [{ id: "ordinary-1", updatedAt: 2 } as SessionListItem], nextCursor: null })),
    getSessionSnapshot: vi.fn(async (sessionId: string) => conversation(sessionId)),
  };
  const service = { read: vi.fn(async () => ({ revision: 7, html: "<!doctype html><p>EXACT_SCREEN</p>", updatedAt: now })) };
  const view: BasketView = {
    settings: { revision: 1, enabled: true, indexChatUploads: false, matchMode: "balanced", embeddingProfileId: "profile" },
    sources: [resource], embeddingProfiles: [], supportedExtensions: [".txt"],
    limits: { maxSources: 200, maxSourceBytes: 100000, maxReadCharacters: 24000 },
  };
  const resources = {
    isReady: vi.fn(() => true),
    list: vi.fn(async () => view),
    readSource: vi.fn<InformationBasketService["readSource"]>(async input => ({
      sourceId: input.sourceId, expectedRevision: input.expectedRevision,
      displayName: resource.displayName, path: resource.path, contentHash: "verified-hash", text: "SELECTED_RESOURCE_CONTENT",
      startChar: input.startChar ?? 0, endChar: (input.startChar ?? 0) + 25, totalCharacters: 9000,
      omittedBefore: input.startChar ?? 0, omittedAfter: 8975, nextStartChar: 25,
    })),
  };
  const dependencies = { service, memory, sessions, resources, now: () => new Date(now), timeZone: "Asia/Jerusalem" };
  const input = { expectedRevision: 7, requestId: "current-request", abortSignal: new AbortController().signal, resourcesAccess: "allowed" as const };
  const capture = () => createSparkHomeAuthoringContextProvider(dependencies).capture(input);
  return { dependencies, input, capture, records, service, memory, status, list, learningList, sessions, resources, view };
}


test("captures bounded passive sources and exact old HTML without reading Resource content", async () => {
  const f = fixture();
  const captured = await f.capture();
  const html = readSparkHomeReference(captured.authoring);
  expect(captured.resourceBindings).toEqual([{ sourceId: "registered-1", expectedRevision: 4 }]);
  expect(f.resources.list).toHaveBeenCalledExactlyOnceWith({ verifySources: false, abortSignal: f.input.abortSignal });
  expect(f.resources.readSource).not.toHaveBeenCalled();
  expect(html.resourceIndex.entries).toEqual([expect.objectContaining({ sourceId: "registered-1", contentStatus: "not_loaded" })]);
  expect(html.screen).toEqual({ revision: 7, expectedRevision: 7, html: "<!doctype html><p>EXACT_SCREEN</p>", updatedAt: now, htmlTruncated: false });
  expect(html.memories.saved.entries[0]).toMatchObject({ id: "saved-1", status: "saved", provenance: saved.provenance });
  expect(html.memories.passive.entries[0]).toMatchObject({ id: "passive-1", certainty: "observed", provenance: passive.provenance });
  expect(html.memories.candidates.entries[0]).toMatchObject({ id: "candidate-1", status: "candidate_not_saved", certainty: "inferred" });
  expect(html.resources).toMatchObject({ status: "not_loaded", excerpts: [] });
  expect(captured.authoring).not.toContain("MUST_NOT_PROJECT_VECTOR");
  expect(captured.authoring).not.toContain("CURRENT_REQUEST_MUST_NOT_DUPLICATE");
  expect(captured.authoring).not.toContain("SELECTED_RESOURCE_CONTENT");
  expect(f.service.read).toHaveBeenCalledTimes(1);
  expect(f.sessions.listSessions).toHaveBeenCalledTimes(1);
  expect(f.status).toHaveBeenCalledTimes(1);
  expect(f.learningList).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(captured.planning)).not.toContain("EXACT_SCREEN");
  expect(JSON.stringify(captured.planning)).not.toContain("CURRENT_REQUEST_MUST_NOT_DUPLICATE");
  expect(captured.authoring).not.toContain(resource.path);
  expect(html.creationContext).toEqual({ capturedAt: now, timeZone: "Asia/Jerusalem" });
  expect(html).toMatchObject({ addsUserIntent: false, grantsActionAuthority: false, establishesCompletion: false });
});

test("cold start permits no SPARK or ordinary history", async () => {
  const f = fixture();
  const sessions: AuthoringContextDependencies["sessions"] = {
    listSessions: async () => ({ sessions: [], nextCursor: null }),
    getSessionSnapshot: async () => null,
  };
  const captured = await createSparkHomeAuthoringContextProvider({ ...f.dependencies, sessions }).capture(f.input);
  expect(captured.planning.relevance.history.status).toBe("empty");
  expect(readSparkHomeReference(captured.authoring).history.entries).toEqual([]);
});

test("captured values are immutable source snapshots", async () => {
  const f = fixture();
  const captured = await f.capture();
  f.service.read.mockResolvedValue({ revision: 9, html: "CHANGED_SCREEN", updatedAt: now });
  f.records.splice(0, 2, { ...saved, content: "CHANGED_MEMORY" });
  f.resources.list.mockResolvedValue({ ...f.view, sources: [] });
  expect(captured.authoring).not.toContain("CHANGED_");
  expect(captured.resourceBindings).toHaveLength(1);
  expect(f.resources.readSource).not.toHaveBeenCalled();
});

test("disabled, blocked and empty sources are distinct and cause no forbidden read", async () => {
  const f = fixture();
  f.dependencies.memory = { ...f.memory, enabled: false };
  const captured = await createSparkHomeAuthoringContextProvider(f.dependencies).capture({ ...f.input, resourcesAccess: "blocked" });
  const html = readSparkHomeReference(captured.authoring);
  expect(html.memories.saved.status).toBe("disabled");
  expect(html.resourceIndex.status).toBe("blocked");
  expect(captured.resourceBindings).toEqual([]);
  expect(f.status).not.toHaveBeenCalled();
  expect(f.list).not.toHaveBeenCalled();
  expect(f.resources.list).not.toHaveBeenCalled();
  expect(f.resources.readSource).not.toHaveBeenCalled();
  const empty = fixture();
  empty.records.length = 0;
  empty.learningList.mockResolvedValue([]);
  empty.resources.list.mockResolvedValue({ ...empty.view, sources: [] });
  const reference = readSparkHomeReference((await empty.capture()).authoring);
  expect(reference.memories.saved.status).toBe("empty");
  expect(reference.resourceIndex.status).toBe("empty");
});

test("Resources not ready and disabled statuses never expose uncaptured bindings", async () => {
  const f = fixture();
  f.resources.list.mockResolvedValue({ ...f.view, settings: { ...f.view.settings, enabled: false } });
  expect(readSparkHomeReference((await f.capture()).authoring).resourceIndex.status).toBe("disabled");
  f.resources.list.mockResolvedValue({ ...f.view, sources: [{ ...resource, status: "stale" }] });
  expect(readSparkHomeReference((await f.capture()).authoring).resourceIndex).toMatchObject({ reason: "no_ready_indexed_sources", nonReadyCount: 1 });
  f.resources.list.mockResolvedValue(f.view);
  f.resources.isReady.mockReturnValue(false);
  expect(readSparkHomeReference((await f.capture()).authoring).resourceIndex.reason).toBe("resources_retrieval_not_ready");
  expect(f.resources.readSource).not.toHaveBeenCalled();
});

test.each(["memory", "history", "resource index", "screen"])("enabled %s failure is not an empty source", async failing => {
  const f = fixture();
  const failure = new Error("PRIVATE_STORAGE_ERROR");
  if (failing === "memory") f.list.mockRejectedValue(failure);
  if (failing === "history") f.sessions.listSessions.mockRejectedValue(failure);
  if (failing === "resource index") f.resources.list.mockRejectedValue(failure);
  if (failing === "screen") f.service.read.mockRejectedValue(failure);
  await expect(f.capture()).rejects.toMatchObject({ name: "SparkHomeContextError" });
  await expect(f.capture()).rejects.not.toThrow("PRIVATE_STORAGE_ERROR");
});

test("stale revision, oversized HTML and cancellation fail without truncating or authoring", async () => {
  const f = fixture();
  await expect(createSparkHomeAuthoringContextProvider(f.dependencies).capture({ ...f.input, expectedRevision: 6 }))
    .rejects.toMatchObject({ code: "spark_home_context_screen_revision_conflict" });
  expect(f.status).not.toHaveBeenCalled();
  const html = "x".repeat(SPARK_HOME_MAX_HTML_BYTES);
  f.service.read.mockResolvedValue({ revision: 7, html, updatedAt: now });
  expect(readSparkHomeReference((await f.capture()).authoring).screen.html).toBe(html);
  f.service.read.mockResolvedValue({ revision: 7, html: html + "x", updatedAt: now });
  await expect(f.capture()).rejects.toMatchObject({ code: "spark_home_context_screen_invalid" });
  const controller = new AbortController(); controller.abort();
  await expect(createSparkHomeAuthoringContextProvider(f.dependencies).capture({ ...f.input, abortSignal: controller.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
});

test("records, expiry, history and index have deterministic disclosed bounds", async () => {
  const f = fixture();
  f.records.splice(0, 2, ...Array.from({ length: 510 }, (_, index) => ({ ...saved, id: `memory-${index}`, content: "m".repeat(1800) })));
  f.learningList.mockResolvedValue(Array.from({ length: 30 }, (_, index) => ({ ...candidate, id: `candidate-${index}`,
    expiresAt: index === 0 ? "2026-10-31T00:00:00Z" : candidate.expiresAt })));
  f.resources.list.mockResolvedValue({ ...f.view, sources: Array.from({ length: 50 }, (_, index) => ({ ...resource, sourceId: `source-${index}` })) });
  const html = readSparkHomeReference((await f.capture()).authoring);
  expect(html.memories.saved).toMatchObject({ availableCount: 510, scannedCount: 500, omittedOutsideWindow: 10 });
  expect(html.memories.saved.omittedByBudget).toBeGreaterThan(0);
  expect(html.memories.candidates.availableCount).toBe(29);
  expect(html.memories.candidates.excludedExpiredCount).toBe(1);
  expect(html.resourceIndex.entries.length).toBeLessThanOrEqual(40);
  expect(html.resourceIndex.omittedCount).toBeGreaterThanOrEqual(10);
  expect(JSON.stringify(html.resourceIndex.entries).length).toBeLessThanOrEqual(limits.resourceIndexCharacters);
  expect(JSON.stringify(html.memories.saved.entries).length).toBeLessThanOrEqual(limits.savedCharacters);
});

test("saved appearance remains an optional reference without manufacturing intent", async () => {
  const f = fixture();
  const captured = await createSparkHomeAuthoringContextProvider(f.dependencies).capture({ ...f.input,
    appearance: { source: "saved_appearance", background: "#aabbcc" } });
  expect(readSparkHomeReference(captured.authoring)).toMatchObject({ addsUserIntent: false, grantsActionAuthority: false,
    appearance: { source: "saved_appearance", background: "#aabbcc", mandatory: false } });
});
