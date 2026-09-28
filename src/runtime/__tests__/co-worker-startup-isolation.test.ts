import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningMemoryService } from "../long-term-memory/maturation/contracts.js";
import type { PassiveLearningConnection, PassiveLearningModel, PassiveLearningService } from "../passive-learning/contracts.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
import { createPendingLearningBatch } from "../passive-learning/batch-lifecycle.js";
import { DEFAULT_MATURATION_POLICY } from "../long-term-memory/maturation/retention.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
});

async function fixture(failedActivity?: "proactive" | "reassessment") {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-startup-isolation-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "fixture-"));
  const timestamp = new Date().toISOString();
  const pending = createPendingLearningBatch([{
    id: "observation", timestamp, sequence: 1, deviceId: "computer",
    source: { app: "editor", windowId: "window" }, content: "Project note",
    kind: "view", extraction: "uia", coverage: "complete",
  }], "old-generation", Date.now());
  await createLearningStateStore(directory).write({ schemaVersion: 1,
    preferences: { ...DEFAULT_LEARNING_PREFERENCES, enabled: true, processingPaused: false,
      modelProfileId: "model", proactiveEnabled: true }, batches: [pending] });
  const memory = { status: async () => ({ enabled: true, available: true }),
    saveObservationBatch: async () => ({ recordIds: [], createdAt: timestamp }),
  } as unknown as LongTermMemoryService;
  const extract = vi.fn<PassiveLearningModel["extract"]>(async () => []);
  const model = { validateProfile: vi.fn(), extract };
  const resourceUsage = vi.fn(async () => ({ schemaVersion: 1 as const, timeZone: "UTC", startedAt: Date.now(),
    resetsAt: Date.now() + 86_400_000, modelCalls: 0, embeddingCalls: 0, embeddingCharacters: 0, activeCalls: 0 }));
  const proactive = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    preferencesChanged: vi.fn(async () => {}), knowledgeChanged: vi.fn(), beginInteractive: () => () => {},
    status: vi.fn(async () => ({ state: "waiting" as const, proposals: [] })), dismiss: vi.fn(async () => {}),
  };
  const reassessment = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    preferencesChanged: vi.fn(async () => {}), knowledgeChanged: vi.fn(), beginInteractive: () => () => {},
    status: vi.fn(() => ({ state: "waiting" as const })),
  };
  const activity = failedActivity ? { proactive, reassessment }[failedActivity] : undefined;
  activity?.start.mockRejectedValueOnce(new Error("private broken optional store"));
  activity?.status.mockImplementation(() => { throw new Error("private inaccessible optional store"); });
  const close = vi.fn();
  const connect = vi.fn<PassiveLearningConnection>(async (input) => {
    input.onEvent({ type: "status", deviceId: "computer", ownerId: "owner", leaseId: input.leaseId, state: "collecting" });
    return { close };
  });
  const service: PassiveLearningService = createPassiveLearningService({ directory, ownerId: "owner",
    memory, model, connect, batchDelayMs: 50,
    backgroundDependencies: () => ({ memory, model, proactive, reassessment, resourceUsage }) });
  cleanup.push(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service, proactive, reassessment, activity: activity!, connect, close, extract, model, memory, resourceUsage };
}

describe("independent Co-worker startup", () => {
  test("clears the startup failure delay after a successful same-value availability recheck", async () => {
    const f = await fixture();
    const status = vi.spyOn(f.memory, "status");
    status.mockResolvedValue({ enabled: true, available: false } as Awaited<ReturnType<typeof f.memory.status>>);
    await f.service.start();
    expect((await f.service.status()).processingReason).toBe("learning_memory_unavailable");
    await f.service.flush();
    expect(f.extract).not.toHaveBeenCalled();
    status.mockRestore();
    await f.service.configure({ processingPaused: false });
    await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    expect(await f.service.status()).toMatchObject({ pendingObservations: 0 });
    expect((await f.service.status()).processingReason).toBeUndefined();
  });

  test.each(["model", "memory"])("starts saved-off collection during a %s outage without starting processing", async (failure) => {
    const f = await fixture();
    const store = createLearningStateStore(f.directory);
    const saved = await store.read();
    await store.write({ ...saved, preferences: { ...saved.preferences, enabled: false } });
    const status = vi.spyOn(f.memory, "status");
    if (failure === "model") f.model.validateProfile.mockImplementation(() => { throw new Error("learning_model_profile_unavailable"); });
    if (failure === "memory") status.mockResolvedValue({ enabled: true, available: false } as Awaited<ReturnType<typeof f.memory.status>>);
    await f.service.start();
    expect(f.connect).not.toHaveBeenCalled();
    f.model.validateProfile.mockClear(); status.mockClear();
    await expect(f.service.configure({ enabled: true })).resolves.toMatchObject({
      preferences: { enabled: true, processingPaused: false }, collectionState: "collecting", pendingObservations: 1,
      processingReason: failure === "model" ? "learning_model_profile_unavailable" : "learning_memory_unavailable" });
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.model.validateProfile).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.extract).not.toHaveBeenCalled();
    expect((await store.read()).preferences.enabled).toBe(true);
    expect((await f.service.batches())[0]?.status).toBe("pending");
    await expect(f.service.configure({ processingPaused: false })).rejects.toThrow();
    f.model.validateProfile.mockReset(); status.mockRestore();
    await f.service.configure({ processingPaused: false });
    await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    expect((await f.service.status()).pendingObservations).toBe(0);
  });

  test("preserves a review until both embedding stages fit without spending a model call", async () => {
    const f = await fixture();
    const usage = { ...await f.resourceUsage(), embeddingCalls: 95 };
    f.resourceUsage.mockImplementation(async () => ({ ...usage }));
    const prepare = vi.fn<LearningMemoryService["prepare"]>(async () => {
      usage.embeddingCalls += 1;
      return { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
        presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1, knowledgeRevision: 1,
        referenceTime: new Date().toISOString(), entries: [], omitted: 0 };
    });
    const apply = vi.fn<LearningMemoryService["apply"]>(async (input) => {
      usage.embeddingCalls += 1;
      return { batchId: input.batchId, recordIds: [], candidateIds: ["candidate"], removedCandidateCount: 0,
        createdAt: new Date().toISOString(), expiresAt: input.batchExpiresAt };
    });
    const review = vi.fn(async () => []);
    Object.assign(f.memory, { learning: { policy: async () => DEFAULT_MATURATION_POLICY, receipt: async () => undefined,
      reviewAdmission: async () => ({ available: true, retryAt: null }), prepare, apply } });
    Object.assign(f.model, { review });
    await f.service.start();
    await f.service.flush();
    expect(prepare).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    expect((await f.service.status()).pendingObservations).toBe(1);
    expect((await f.service.status()).nextAnalysisAt).toBe(new Date(usage.resetsAt).toISOString());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(prepare).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
    usage.embeddingCalls = 94;
    await f.service.configure({ analysisIntervalMinutes: 1 });
    await f.service.flush();
    expect(prepare).toHaveBeenCalledOnce(); expect(review).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledOnce();
    expect(usage.embeddingCalls).toBe(96);
    expect((await f.service.status()).pendingObservations).toBe(0);
  });

  test.each(["model", "memory"])("stops collection during a startup %s outage without revalidating processing", async (failure) => {
    const f = await fixture();
    const status = vi.spyOn(f.memory, "status");
    if (failure === "model") f.model.validateProfile.mockImplementation(() => { throw new Error("learning_model_profile_unavailable"); });
    if (failure === "memory") status.mockResolvedValue({ enabled: true, available: false } as Awaited<ReturnType<typeof f.memory.status>>);
    await f.service.start();
    expect(f.connect).toHaveBeenCalledOnce();
    f.model.validateProfile.mockClear(); status.mockClear();
    await expect(f.service.configure({ enabled: false })).resolves.toMatchObject({
      preferences: { enabled: false, processingPaused: false }, collectionState: "off", pendingObservations: 1 });
    expect(f.close).toHaveBeenCalledOnce();
    await f.service.configure({ proactiveEnabled: false });
    await f.service.configure({ collectionWindow: { start: "09:00", end: "17:00", timeZone: "UTC" } });
    expect(f.model.validateProfile).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.extract).not.toHaveBeenCalled(); expect(f.connect).toHaveBeenCalledOnce();
    expect((await createLearningStateStore(f.directory).read()).preferences.enabled).toBe(false);
    expect((await f.service.batches())[0]?.status).toBe("pending");
    await expect(f.service.configure({ processingPaused: false })).rejects.toThrow();
  });

  test("starts and configures the review memory path without the optional legacy writer", async () => {
    const f = await fixture();
    const prepare = vi.fn(async () => ({ kind: "learning_knowledge_reference_v1", authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 0, knowledgeRevision: 0,
      referenceTime: new Date().toISOString(), entries: [], omitted: 0 }));
    const apply = vi.fn<LearningMemoryService["apply"]>(async (input) => ({ batchId: input.batchId,
      recordIds: [], candidateIds: ["candidate"], removedCandidateCount: 0,
      createdAt: new Date().toISOString(), expiresAt: input.batchExpiresAt }));
    const review = vi.fn(async () => []);
    Object.assign(f.memory, { saveObservationBatch: undefined, learning: {
      policy: async () => DEFAULT_MATURATION_POLICY,
      receipt: async () => undefined, reviewAdmission: async () => ({ available: true, retryAt: null }), prepare, apply,
    } });
    Object.assign(f.model, { review });
    await f.service.start();
    expect((await f.service.status()).processingReason).toBeUndefined();
    await expect(f.service.configure({ modelProfileId: "replacement" })).resolves.toMatchObject({
      preferences: { modelProfileId: "replacement" }, pendingObservations: 1 });
    await f.service.flush();
    expect(prepare).toHaveBeenCalledOnce(); expect(review).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledOnce();
    expect(f.extract).not.toHaveBeenCalled();
    expect((await f.service.batches())[0]?.status).toBe("reviewed");
    expect((await f.service.status()).pendingObservations).toBe(0);
  });

  test.each(["memory", "model"])("requires the legacy writer when the %s review side is missing", async (missing) => {
    const f = await fixture();
    Object.assign(f.memory, { saveObservationBatch: undefined,
      learning: missing === "memory" ? undefined : { receipt: async () => undefined, prepare: vi.fn(), apply: vi.fn() } });
    if (missing !== "model") Object.assign(f.model, { review: vi.fn() });
    await f.service.start();
    expect((await f.service.status()).processingReason).toBe("learning_memory_unavailable");
    await expect(f.service.configure({ processingPaused: false })).rejects.toThrow("learning_memory_unavailable");
    expect(f.extract).not.toHaveBeenCalled();
  });

  test("unavailable usage does not reject saved settings or fabricate zero resource consumption", async () => {
    const f = await fixture(); await f.service.start();
    const usage = await f.resourceUsage();
    f.resourceUsage.mockRejectedValue(new Error("private unreadable budget"));
    const saved = await f.service.configure({ analysisIntervalMinutes: 2 });
    expect(saved.preferences.analysisIntervalMinutes).toBe(2);
    expect(saved.resourceUsage).toBeUndefined();
    const status = await f.service.status();
    expect(status).toMatchObject({ collectionState: "collecting", pendingObservations: 1,
      proactive: { state: "waiting" }, reassessment: { state: "waiting" } });
    expect(status.resourceUsage).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("private");
    expect((await createLearningStateStore(f.directory).read()).preferences.analysisIntervalMinutes).toBe(2);
    expect(f.extract).not.toHaveBeenCalled();
    f.resourceUsage.mockResolvedValue(usage);
    expect((await f.service.status()).resourceUsage).toEqual(usage);
  });

  test.each(["model", "memory"])("preserves pending observations while startup %s availability fails", async (failure) => {
    const f = await fixture();
    const status = vi.spyOn(f.memory, "status");
    if (failure === "model") f.model.validateProfile.mockImplementation(() => { throw new Error("learning_model_profile_unavailable"); });
    if (failure === "memory") status.mockResolvedValue({ enabled: true, available: false } as Awaited<ReturnType<typeof f.memory.status>>);
    await f.service.start();
    const input = f.connect.mock.calls[0]![0];
    input.onEvent({ type: "observation", deviceId: "computer", ownerId: "owner", leaseId: input.leaseId,
      observation: { id: "new", timestamp: new Date().toISOString(), sequence: 2, source: { app: "Editor", windowId: "1" },
        content: "New project note", kind: "view", extraction: "uia", coverage: "complete" } });
    await vi.advanceTimersByTimeAsync(60_000); await f.service.flush();
    expect(f.extract).not.toHaveBeenCalled();
    expect(await f.service.status()).toMatchObject({ collectionState: "collecting", pendingObservations: 2,
      processingReason: expect.any(String) });
    expect((await f.service.status()).nextAnalysisAt).toBeUndefined();
    expect((await f.service.batches())[0]?.status).toBe("pending");
    await expect(f.service.configure({ analysisIntervalMinutes: 2 })).rejects.toThrow();
    f.model.validateProfile.mockReset(); status.mockRestore();
    await f.service.configure({ analysisIntervalMinutes: 2 });
    expect((await f.service.status()).processingReason).toBeUndefined();
    await f.service.flush(); await f.service.flush();
    expect(f.extract).toHaveBeenCalledTimes(2);
    expect((await f.service.status()).pendingObservations).toBe(0);
  });

  test("reports inaccessible proactive status without rejecting persisted preferences", async () => {
    const f = await fixture(); await f.service.start();
    f.proactive.status.mockRejectedValue(new Error("private unreadable store"));
    await expect(f.service.configure({ analysisIntervalMinutes: 2 })).resolves.toMatchObject({
      preferences: { analysisIntervalMinutes: 2 }, proactive: { state: "failed", reason: "proactive_failed" } });
  });

  test.each(["proactive", "reassessment"] as const)("isolates a failed %s startup from other activities", async (failedActivity) => {
    const f = await fixture(failedActivity);
    await f.service.start();
    expect(f.proactive.start).toHaveBeenCalledOnce();
    expect(f.reassessment.start).toHaveBeenCalledOnce();
    expect(f.activity.stop).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledOnce();
    const status = await f.service.status();
    expect(status).toMatchObject({ state: "collecting", collectionState: "collecting", pendingObservations: 1 });
    expect(status.processingReason).toBeUndefined();
    expect(status.nextAnalysisAt).toBeDefined();
    expect(status[failedActivity]).toMatchObject({ state: "failed",
      reason: failedActivity === "proactive" ? "proactive_start_failed" : "learning_reassessment_start_failed" });
    const healthyActivity = failedActivity === "proactive" ? "reassessment" : "proactive";
    expect(status[healthyActivity]).toMatchObject({ state: "waiting" });
    expect(f.activity.status).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain("private");
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(f.extract).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect((await f.service.batches())[0]?.status).toBe("discarded"));
    expect((await f.service.status())[failedActivity]?.state).toBe("failed");
    await f.service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.activity.start).toHaveBeenCalledOnce();
    expect(f.extract).toHaveBeenCalledOnce();
  });
});
