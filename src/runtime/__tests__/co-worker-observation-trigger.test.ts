import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES, normalizeLearningPreferences } from "../passive-learning/store.js";
import type { PassiveLearningConnection, PassiveLearningModel, PassiveLearningService } from "../passive-learning/contracts.js";
import type { LearningBackgroundContext } from "../passive-learning/background-dependencies.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

async function fixture(threshold = 100) {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-26T08:00:00Z"));
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-reason-and-trigger-20260926/tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "fixture-"));
  const extract = vi.fn<PassiveLearningModel["extract"]>(async () => []);
  const memory = { status: async () => ({ enabled: true, available: true }),
    saveObservationBatch: async () => ({ recordIds: [], createdAt: new Date().toISOString() }),
  } as unknown as LongTermMemoryService;
  const model = { validateProfile() {}, supportsParallelBatches: () => true, extract };
  const reset = Date.now() + 60_000;
  let used = 0, sequence = 0;
  const resourceUsage = vi.fn(async () => ({ schemaVersion: 1 as const, timeZone: "UTC", startedAt: reset - 60_000,
    resetsAt: reset, modelCalls: used, embeddingCalls: 0, embeddingCharacters: 0, activeCalls: 0 }));
  let source!: Parameters<PassiveLearningConnection>[0];
  let context!: LearningBackgroundContext;
  const services: PassiveLearningService[] = [];
  const open = () => {
    const service = createPassiveLearningService({ directory, ownerId: "owner", memory, model,
      connect: async (input) => { source = input; return { close() {} }; },
      backgroundDependencies: (value) => { context = value; return { model, memory, resourceUsage }; } });
    services.push(service); return service;
  };
  cleanup.push(async () => { for (const service of services) await service.stop(); await rm(directory, { recursive: true, force: true }); });
  const service = open(); await service.start();
  await service.configure({ enabled: true, processingPaused: false, modelProfileId: "local", analysisTrigger: "observations", analysisObservationCount: threshold });
  const observe = (count: number, app = "Editor", content = "Observation") => {
    for (let i = 0; i < count; i++) {
      sequence += 1;
      source.onEvent({ type: "observation", deviceId: "device", ownerId: "owner", leaseId: source.leaseId,
        observation: { id: `o${sequence}`, sequence, timestamp: new Date().toISOString(), source: { app, windowId: "window" },
          content: `${content} ${sequence}`, kind: "view", extraction: "uia", coverage: "complete" } });
    }
  };
  return { service, open, observe, extract, memory, resourceUsage, directory, setUsed: (count: number) => { used = count; }, context: () => context };
}

describe("observation count review admission", () => {
  test("waits below threshold, then drains its snapshot in bounded batches while new intake waits", async () => {
    const f = await fixture();
    await f.service.configure({ processingExcludedApplications: ["Game"] });
    f.observe(40, "Game"); f.observe(99);
    expect(await f.service.status()).toMatchObject({ pendingObservations: 99, blockedObservations: 40 });
    expect((await f.service.status()).nextAnalysisAt).toBeUndefined();
    expect(f.context().isProcessingBusy!()).toBe(false);
    f.resourceUsage.mockClear();
    await vi.advanceTimersByTimeAsync(2 * 3_600_000); await f.service.flush();
    expect(f.extract).not.toHaveBeenCalled(); expect(f.resourceUsage).not.toHaveBeenCalled();
    f.observe(1);
    expect((await f.service.status()).nextAnalysisAt).toBe(new Date().toISOString());
    await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    expect(f.extract.mock.calls[0]![0].observations).toHaveLength(16);
    expect(f.extract.mock.calls[0]![0].observations.every((item) => item.source.app === "Editor")).toBe(true);
    expect(await f.service.status()).toMatchObject({ pendingObservations: 84, blockedObservations: 40 });
    f.observe(5);
    for (let i = 0; i < 6; i++) await f.service.flush();
    expect(f.extract).toHaveBeenCalledTimes(7);
    const reviewed = f.extract.mock.calls.flatMap(([input]) => input.observations.map((item) => item.id));
    expect(new Set(reviewed).size).toBe(100);
    expect(reviewed).toHaveLength(100);
    expect(f.extract.mock.calls.every(([input]) => input.observations.length <= 16)).toBe(true);
    expect(await f.service.status()).toMatchObject({ pendingObservations: 5, blockedObservations: 40, reviewPassRemaining: 0 });
    expect((await f.service.status()).nextAnalysisAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.extract).toHaveBeenCalledTimes(7);
  });

  test("unblocking retained work crosses the threshold while collection is stopped", async () => {
    const f = await fixture(4);
    await f.service.configure({ processingExcludedApplications: ["Editor"] });
    f.observe(4); await f.service.configure({ enabled: false });
    await f.service.flush(); expect(f.extract).not.toHaveBeenCalled();
    await f.service.configure({ processingExcludedApplications: [] });
    await f.service.flush(); expect(f.extract).toHaveBeenCalledOnce();
    expect((await f.service.status()).pendingObservations).toBe(0);
  });

  test("honors processing hours, pause and the shared budget without interval fallback", async () => {
    const f = await fixture(2);
    await f.service.configure({ analysisWindow: { start: "09:00", end: "17:00", timeZone: "UTC" } });
    f.observe(2); await f.service.flush();
    expect(f.extract).not.toHaveBeenCalled();
    expect((await f.service.status()).nextAnalysisAt).toBe("2026-09-26T09:00:00.000Z");
    await f.service.configure({ processingPaused: true });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.extract).not.toHaveBeenCalled();
    await f.service.configure({ processingPaused: false }); await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
  });

  test("defers enough observations at budget exhaustion, without repeated resource probes", async () => {
    const f = await fixture(2); f.setUsed(24); f.observe(2); await f.service.flush();
    expect(f.extract).not.toHaveBeenCalled();
    expect((await f.service.status()).nextAnalysisAt).toBe("2026-09-26T08:01:00.000Z");
    f.resourceUsage.mockClear();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(f.resourceUsage).not.toHaveBeenCalled();
    f.setUsed(0); await vi.advanceTimersByTimeAsync(1_000); await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
  });

  test("does not count active work toward another parallel call", async () => {
    const f = await fixture(2); await f.service.configure({ maxConcurrentBatches: 2 });
    let release!: () => void;
    f.extract.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return []; });
    f.observe(2); const running = f.service.flush();
    await vi.waitFor(() => expect(f.extract).toHaveBeenCalledOnce());
    try {
      f.observe(1);
      expect(await f.service.status()).toMatchObject({ pendingObservations: 1, activeBatches: 1 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.extract).toHaveBeenCalledOnce();
    } finally { release(); await running; }
    f.observe(1); await f.service.flush(); expect(f.extract).toHaveBeenCalledTimes(2);
  });

  test("resumes an admitted pass after restart and separates new intake sharing a persisted batch", async () => {
    const f = await fixture(40); f.observe(40); await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    expect(await f.service.status()).toMatchObject({ pendingObservations: 24, reviewPassRemaining: 24 });
    f.observe(2); await f.service.stop();
    const saved = await createLearningStateStore(f.directory).read();
    expect(saved.preferences).toMatchObject({ analysisTrigger: "observations", analysisObservationCount: 40, analysisIntervalMinutes: 15 });
    expect(saved.observationReviewPass).toHaveLength(40);
    const next = f.open(); await next.start(); await next.flush();
    await next.flush(); expect(f.extract).toHaveBeenCalledTimes(3);
    expect(f.extract.mock.calls.flatMap(([input]) => input.observations)).toHaveLength(40);
    expect(await next.status()).toMatchObject({ pendingObservations: 2, reviewPassRemaining: 0 });
    await next.configure({ analysisTrigger: "interval", analysisIntervalMinutes: 1 });
    expect((await next.status()).nextAnalysisAt).toBe(new Date(Date.now() + 60_000).toISOString());
    await vi.advanceTimersByTimeAsync(60_000); await next.flush();
    expect(f.extract).toHaveBeenCalledTimes(4);
    const legacy = normalizeLearningPreferences({ analysisIntervalMinutes: 5 }, DEFAULT_LEARNING_PREFERENCES);
    expect(legacy).toMatchObject({ analysisTrigger: "interval", analysisIntervalMinutes: 5 });
  });

  test("drains fragmented two-observation batches without climbing back to 40", async () => {
    const f = await fixture(40);
    await f.service.configure({ processingPaused: true });
    for (let i = 0; i < 3; i++) { f.observe(2); await f.service.configure({ processingPaused: true }); }
    f.observe(34);
    await f.service.configure({ processingPaused: false });
    for (let i = 0; i < 6; i++) await f.service.flush();
    expect(f.extract.mock.calls.map(([input]) => input.observations.length)).toEqual([2, 2, 2, 16, 16, 2]);
    expect(await f.service.status()).toMatchObject({ pendingObservations: 0, reviewPassRemaining: 0 });
  });

  test.each([["x", 71], ["界", 24]] as const)("starts early for large %s observations before the byte cap drops them", async (character, count) => {
    const f = await fixture(100); f.observe(count, "Editor", character.repeat(23_990));
    expect(await f.service.status()).toMatchObject({ pendingObservations: count, droppedObservations: 0 });
    await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    expect(await f.service.status()).toMatchObject({ reviewPassRemaining: count - 16, droppedObservations: 0 });
    for (let i = 0; i < 4; i++) await f.service.flush();
    expect(f.extract.mock.calls.flatMap(([input]) => input.observations)).toHaveLength(count);
    expect((await f.service.status()).pendingObservations).toBe(0);
  });

  test("automatically schedules the rest of an admitted pass without more intake", async () => {
    const f = await fixture(40); f.observe(40);
    await vi.waitFor(() => expect(f.extract).toHaveBeenCalledTimes(3));
    await f.service.flush();
    expect((await f.service.status()).pendingObservations).toBe(0);
    expect(f.extract.mock.calls.flatMap(([input]) => input.observations)).toHaveLength(40);
  });

  test("checks the resource budget again before continuing a pass below the count threshold", async () => {
    const f = await fixture(40); f.observe(40); await f.service.flush();
    f.setUsed(24); await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    expect(await f.service.status()).toMatchObject({ pendingObservations: 24, reviewPassRemaining: 24 });
    f.setUsed(0); await vi.advanceTimersByTimeAsync(60_000);
    await f.service.flush(); await f.service.flush();
    expect(f.extract).toHaveBeenCalledTimes(3);
    expect((await f.service.status()).pendingObservations).toBe(0);
  });

  test("storage pressure honors the daily budget and resumes persisted work after reset", async () => {
    const f = await fixture(100); f.setUsed(24); f.observe(71, "Editor", "x".repeat(23_990));
    await f.service.flush(); expect(f.extract).not.toHaveBeenCalled();
    await f.service.stop(); const next = f.open(); await next.start();
    await next.flush(); expect(f.extract).not.toHaveBeenCalled();
    f.setUsed(0); await vi.advanceTimersByTimeAsync(60_000); await next.flush();
    expect(f.extract).toHaveBeenCalled();
  });

  test("blocked evidence cannot trigger storage-pressure reviews", async () => {
    const f = await fixture(100);
    await f.service.configure({ processingExcludedApplications: ["Game"] });
    f.observe(71, "Game", "x".repeat(23_990));
    await f.service.flush(); expect(f.extract).not.toHaveBeenCalled();
    expect((await f.service.status()).nextAnalysisAt).toBeUndefined();
    f.resourceUsage.mockClear(); await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.resourceUsage).not.toHaveBeenCalled();
    f.observe(1); await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    expect(f.extract.mock.calls[0]![0].observations.map((item) => item.source.app)).toEqual(["Editor"]);
    expect(await f.service.status()).toMatchObject({ pendingObservations: 0, blockedObservations: 71 });
    expect((await f.service.status()).nextAnalysisAt).toBeUndefined();
  });

  test("preserves eligible evidence across a synchronous burst of processing-excluded intake", async () => {
    const f = await fixture(100);
    await f.service.configure({ processingExcludedApplications: ["Game"] });
    f.observe(1);
    f.observe(100, "Game", "x".repeat(23_990));
    const before = await f.service.status();
    expect(before.pendingObservations).toBe(1);
    expect(before.droppedObservations).toBeGreaterThan(0);
    await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    expect(f.extract.mock.calls[0]![0].observations.map((item) => item.id)).toEqual(["o1"]);
    expect((await f.service.status()).pendingObservations).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.extract).toHaveBeenCalledOnce();
  });

  test.each([["bytes", 71, "x".repeat(23_990)], ["items", 103, "Observation"]] as const)(
    "starts below the threshold when blocked intake puts eligible work at risk from %s", async (_limit, count, content) => {
    const f = await fixture(200);
    await f.service.configure({ processingExcludedApplications: ["Game"] });
    for (let i = 0; i < count; i++) { f.observe(1, "Game", content); f.observe(1); }
    expect(await f.service.status()).toMatchObject({ pendingObservations: count, blockedObservations: count, droppedObservations: 0 });
    await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    expect(await f.service.status()).toMatchObject({ reviewPassRemaining: count - 16, droppedObservations: 0 });
    for (let i = 0; i < Math.ceil(count / 16) - 1; i++) await f.service.flush();
    const observations = f.extract.mock.calls.flatMap(([input]) => input.observations);
    expect(observations).toHaveLength(count);
    expect(observations.every((item) => item.source.app === "Editor")).toBe(true);
    expect(await f.service.status()).toMatchObject({ pendingObservations: 0, blockedObservations: count, droppedObservations: 0 });
    expect((await f.service.status()).nextAnalysisAt).toBeUndefined();
  });

  test.each(["learning_memory_unavailable", "learning_knowledge_conflict", "co_worker_resources_busy"])(
    "delays pending %s failures while preserving the admitted pass", async (reason) => {
      const f = await fixture(40); await f.service.configure({ analysisIntervalMinutes: 1 });
      const save = vi.spyOn(f.memory, "saveObservationBatch").mockRejectedValue(new Error(reason));
      f.observe(40); await f.service.flush();
      expect(f.extract).toHaveBeenCalledOnce();
      expect(await f.service.status()).toMatchObject({ pendingObservations: 40, reviewPassRemaining: 40,
        nextAnalysisAt: "2026-09-26T08:01:00.000Z" });
      await f.service.configure({ enabled: false });
      f.resourceUsage.mockClear(); await vi.advanceTimersByTimeAsync(59_000); await f.service.flush();
      expect(f.extract).toHaveBeenCalledOnce(); expect(f.resourceUsage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000); await f.service.flush();
      expect(f.extract).toHaveBeenCalledTimes(2);
      expect((await f.service.status()).nextAnalysisAt).toBe("2026-09-26T08:02:00.000Z");
      save.mockImplementation(async ({ batchId }) => ({ batchId, recordIds: [], createdAt: new Date().toISOString() }));
      await vi.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 3; i++) await f.service.flush();
      expect((await f.service.status()).pendingObservations).toBe(0);
      expect(f.extract).toHaveBeenCalledTimes(5);
    });

  test("a parallel success does not clear a failed sibling's retry delay", async () => {
    const f = await fixture(40);
    await f.service.configure({ maxConcurrentBatches: 2, analysisIntervalMinutes: 1 });
    let releaseFailure!: () => void, releaseSuccess!: () => void;
    f.extract.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFailure = resolve; });
      throw new Error("learning_knowledge_conflict");
    }).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseSuccess = resolve; }); return [];
    });
    f.observe(40); const running = f.service.flush();
    try {
      await vi.waitFor(() => expect(f.extract).toHaveBeenCalledTimes(2));
      releaseFailure();
      await vi.waitFor(async () => expect((await f.service.batches()).some((batch) => batch.reason === "learning_knowledge_conflict")).toBe(true));
      releaseSuccess(); await running;
      expect((await f.service.status()).pendingObservations).toBe(24);
      const retryAt = Date.parse((await f.service.status()).nextAnalysisAt!);
      await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
      expect(f.extract).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1); await f.service.flush();
      expect(f.extract).toHaveBeenCalledTimes(4);
      expect((await f.service.status()).pendingObservations).toBe(0);
    } finally { releaseFailure?.(); releaseSuccess?.(); await running; }
  });

  test("a paused pass respects new application blocks and explicit pending deletion", async () => {
    const f = await fixture(40); f.observe(40); await f.service.flush();
    await f.service.configure({ processingPaused: true });
    f.observe(1);
    await f.service.configure({ processingExcludedApplications: ["Editor"], processingPaused: false });
    await f.service.flush(); expect(f.extract).toHaveBeenCalledOnce();
    expect((await f.service.status()).pendingObservations).toBe(0);
    await f.service.clearPending();
    await f.service.configure({ processingExcludedApplications: [] });
    await f.service.flush(); expect(f.extract).toHaveBeenCalledOnce();
    expect((await createLearningStateStore(f.directory).read()).observationReviewPass).toBeUndefined();
  });

  test("disarms an interval timer when switching to a count below threshold", async () => {
    const f = await fixture(4); await f.service.configure({ analysisTrigger: "interval", analysisIntervalMinutes: 1 });
    f.observe(3); expect((await f.service.status()).nextAnalysisAt).toBeDefined();
    await f.service.configure({ analysisTrigger: "observations" });
    await vi.advanceTimersByTimeAsync(60_000); expect(f.extract).not.toHaveBeenCalled();
    expect((await f.service.status()).nextAnalysisAt).toBeUndefined();
    await f.service.configure({ analysisObservationCount: 3 }); await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
  });
});
