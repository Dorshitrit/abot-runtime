import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES, normalizeLearningPreferences } from "../passive-learning/store.js";
import { nextCollectionWindowBoundary } from "../passive-learning/collection-window-clock.js";
import { LearningAnalysisClock } from "../passive-learning/analysis-clock.js";
import { availableLearningBatchSlots, learningBudgetDeferral } from "../passive-learning/processing-budget-policy.js";
import type { LearningBackgroundContext, LearningProactiveLifecycle } from "../passive-learning/background-dependencies.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { LearningMemoryService } from "../long-term-memory/maturation/contracts.js";
import type { PassiveLearningConnection, PassiveLearningModel } from "../passive-learning/contracts.js";
import type { CoWorkerResourceUsage } from "../passive-learning/resources/contracts.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });
async function directory() {
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-schedule-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(maintenance?: Partial<LearningMemoryService>, retention?: LongTermMemoryService["retention"]) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T08:59:00Z"));
  const root = await directory();
  const extract = vi.fn<PassiveLearningModel["extract"]>(async () => []);
  const memory = { status: async () => ({ enabled: true, available: true }),
    retention,
    saveObservationBatch: async () => ({ recordIds: [], createdAt: new Date().toISOString() }),
    learning: { receipt: async () => undefined,
      list: async () => [{ id: "candidate", embedding: { vector: [1, 0] } }], ...maintenance },
  } as unknown as LongTermMemoryService;
  const model = { validateProfile: vi.fn((_profileId: string) => {}), extract };
  let source: Parameters<PassiveLearningConnection>[0] | undefined;
  let context: LearningBackgroundContext | undefined;
  let usage: CoWorkerResourceUsage & { activeCalls: number } = { schemaVersion: 1,
    startedAt: Date.now(), resetsAt: Date.now() + 3_600_000, timeZone: "UTC",
    modelCalls: 0, embeddingCalls: 0, embeddingCharacters: 0, activeCalls: 0 };
  const close = vi.fn();
  const connect = vi.fn<PassiveLearningConnection>(async (input) => { source = input; return { close }; });
  const released = vi.fn();
  const proactive = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    preferencesChanged: vi.fn(async () => {}), knowledgeChanged: vi.fn(), beginInteractive: vi.fn(() => released),
    status: vi.fn(async () => ({ state: "waiting" as const, proposals: [] })), dismiss: vi.fn(async () => {}),
    sessionDeleted: vi.fn(async () => {}),
  } satisfies LearningProactiveLifecycle;
  const service = createPassiveLearningService({ directory: root, ownerId: "owner", memory, model, connect,
    backgroundDependencies: (value) => { context = value; return { model, memory, proactive, resourceUsage: async () => usage }; } });
  cleanup.unshift(() => service.stop());
  await service.start();
  const observe = (id: string) => source!.onEvent({ type: "observation", deviceId: "device", ownerId: "owner", leaseId: source!.leaseId,
    observation: { id, timestamp: new Date().toISOString(), sequence: Number(id), source: { app: "editor", windowId: "window" },
      content: `Document ${id}`, kind: "view", extraction: "uia", coverage: "complete" } });
  return { service, root, extract, proactive, connect, close, released, observe,
    validateProfile: model.validateProfile,
    context: () => context!, source: () => source!, setUsage: (next: Partial<typeof usage>) => { usage = { ...usage, ...next }; } };
}

describe("independent Co-worker schedules", () => {
  test("shares the remaining embedding allowance between complete reviews while preserving legacy admission", () => {
    const usage = { schemaVersion: 1 as const, startedAt: 0, resetsAt: 86_400_000, timeZone: "UTC",
      modelCalls: 0, embeddingCalls: 93, embeddingCharacters: 0, activeCalls: 0 };
    const preferences = { ...DEFAULT_LEARNING_PREFERENCES, maxConcurrentBatches: 3 };
    expect(availableLearningBatchSlots(usage, preferences, 3, 2)).toBe(1);
    expect(availableLearningBatchSlots({ ...usage, embeddingCalls: 92 }, preferences, 3, 2)).toBe(2);
    expect(availableLearningBatchSlots({ ...usage, embeddingCalls: 95 }, preferences, 3, 2)).toBe(0);
    expect(learningBudgetDeferral({ ...usage, embeddingCalls: 95 }, preferences, 2)).toEqual({
      until: usage.resetsAt, reason: "co_worker_embedding_daily_budget_exhausted" });
    expect(availableLearningBatchSlots({ ...usage, embeddingCalls: 95 }, preferences, 3)).toBe(1);
    expect(learningBudgetDeferral({ ...usage, embeddingCalls: 95 }, preferences)).toBeUndefined();
  });

  test("waits for a 30-day reconsideration deadline without Node timeout overflow", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
    const run = vi.fn();
    const clock = new LearningAnalysisClock(run);
    const deadline = Date.now() + 30 * 86_400_000;
    clock.arm(Date.now(), 60_000, null, deadline);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(run).not.toHaveBeenCalled();
    expect(clock.scheduledAt).toBe(deadline);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30 * 86_400_000 - 2_147_483_647);
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("reports core retention failures without owning or stopping its lifecycle", async () => {
    const unsubscribe = vi.fn();
    const retention = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      reason: () => "learning_maintenance_failed", subscribeChanges: vi.fn(() => unsubscribe) };
    const f = await fixture(undefined, retention);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retention.start).not.toHaveBeenCalled();
    expect(retention.subscribeChanges).toHaveBeenCalledOnce();
    expect(f.extract).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(await f.service.status()).toMatchObject({ state: "off", maintenanceReason: "learning_maintenance_failed" });
    await f.service.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(retention.stop).not.toHaveBeenCalled();
  });

  test("preserves legacy cadence and chooses separate initial proactive defaults", async () => {
    const root = await directory();
    await writeFile(join(root, "state.json"), JSON.stringify({ schemaVersion: 1,
      preferences: { enabled: false, excludedApplications: [], modelProfileId: "saved" }, batches: [] }));
    const previous = await createLearningStateStore(root).read();
    expect(previous.preferences).toMatchObject({ analysisIntervalMinutes: 5,
      proactiveEnabled: false, proactiveIntervalMinutes: 60, proactiveMessagesPerDay: 2 });
    expect(normalizeLearningPreferences({ modelProfileId: "new" }, DEFAULT_LEARNING_PREFERENCES))
      .toMatchObject({ analysisIntervalMinutes: 15 });
    expect(previous.preferences.proactiveModelProfileId).toBeUndefined();
    const inherited = normalizeLearningPreferences({ modelProfileId: "replacement" }, previous.preferences);
    expect(inherited.proactiveModelProfileId).toBeUndefined();
    expect(inherited.proactiveModelProfileId ?? inherited.modelProfileId).toBe("replacement");
    const explicit = normalizeLearningPreferences({ proactiveModelProfileId: "saved" }, inherited);
    expect(normalizeLearningPreferences({ modelProfileId: "newer" }, explicit).proactiveModelProfileId).toBe("saved");
    const cleared = normalizeLearningPreferences({ proactiveModelProfileId: null }, explicit);
    expect(cleared.proactiveModelProfileId).toBeUndefined();
    await createLearningStateStore(root).write({ schemaVersion: 1, preferences: cleared, batches: [] });
    expect((await createLearningStateStore(root).read()).preferences.proactiveModelProfileId).toBeUndefined();
  });

  test("closes and reopens the native lease at collection boundaries without observations", async () => {
    const f = await fixture();
    await f.service.configure({ enabled: true, processingPaused: true, modelProfileId: "local",
      collectionWindow: { start: "09:00", end: "10:00", timeZone: "UTC" } });
    expect(f.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.connect).toHaveBeenCalledTimes(1);
    const source = f.source();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(source.abortSignal.aborted).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect((await f.service.status()).reason).toBe("learning_outside_collection_window");
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    expect(f.connect).toHaveBeenCalledTimes(2);
    await f.service.configure({ enabled: false });
    const calls = f.connect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(48 * 3_600_000);
    expect(f.connect).toHaveBeenCalledTimes(calls);
  });

  test("applies canonical overnight and DST boundary calculations", () => {
    expect(nextCollectionWindowBoundary(Date.parse("2026-09-25T23:00:00Z"),
      { start: "22:00", end: "06:00", timeZone: "UTC" })).toBe(Date.parse("2026-09-26T06:00:00Z"));
    expect(nextCollectionWindowBoundary(Date.parse("2026-03-08T06:00:00Z"),
      { start: "02:30", end: "04:00", timeZone: "America/New_York" })).toBe(Date.parse("2026-03-08T08:00:00Z"));
    expect(nextCollectionWindowBoundary(Date.now(), null)).toBeUndefined();
  });

  test("defers exhausted processing before taking or journaling data", async () => {
    const f = await fixture();
    await f.service.configure({ enabled: true, processingPaused: false, modelProfileId: "local", analysisIntervalMinutes: 1 });
    f.setUsage({ modelCalls: 24 });
    f.observe("1");
    const file = join(f.root, "state.json");
    const before = await stat(file);
    await f.service.flush();
    expect(f.extract).not.toHaveBeenCalled();
    expect(await f.service.batches()).toEqual([]);
    expect((await f.service.status()).pendingObservations).toBe(1);
    expect((await f.service.status()).nextAnalysisAt).toBe("2026-09-25T09:59:00.000Z");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.extract).not.toHaveBeenCalled();
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(JSON.parse(await readFile(file, "utf8")).batches).toEqual([]);
  });

  test("proactive remains independent, exposes delivery events and receives foreground preemption", async () => {
    const f = await fixture();
    await f.service.configure({ enabled: false, processingPaused: true,
      proactiveEnabled: true, proactiveModelProfileId: "cloud" });
    expect(f.proactive.start).toHaveBeenCalledOnce();
    expect(f.proactive.preferencesChanged).toHaveBeenCalledOnce();
    expect(f.context().isStarted()).toBe(true);
    expect(f.connect).not.toHaveBeenCalled();
    const listener = vi.fn(); f.service.subscribe(listener);
    const event = { type: "proposal_delivered" as const, proposalId: "proposal", sessionId: "session" };
    f.context().changed(event);
    expect(listener).toHaveBeenCalledWith(event);
    const release = f.service.beginInteractive();
    expect(f.context().isInteractiveBusy()).toBe(true);
    release(); release();
    expect(f.released).toHaveBeenCalledOnce();
    expect(f.context().isInteractiveBusy()).toBe(false);
    await f.service.dismissProposal!("proposal");
    expect(f.proactive.dismiss).toHaveBeenCalledWith("proposal");
    await f.service.sessionDeleted!("session");
    expect(f.proactive.sessionDeleted).toHaveBeenCalledWith("session");
    f.service.notifyKnowledgeChanged!();
    expect(f.proactive.knowledgeChanged).toHaveBeenCalledOnce();
    expect(await f.service.candidates!()).toEqual([{ id: "candidate" }]);
    await f.service.stop();
    expect(f.proactive.stop).toHaveBeenCalledOnce();
  });

  test("insufficient remaining embedding capacity defers the pending batch instead of retrying every interval", async () => {
    const f = await fixture();
    await f.service.configure({ enabled: true, processingPaused: false, modelProfileId: "local", analysisIntervalMinutes: 1 });
    f.extract.mockRejectedValueOnce(new Error("co_worker_embedding_character_budget_exhausted"));
    f.observe("1");
    await f.service.flush();
    expect(f.extract).toHaveBeenCalledOnce();
    const before = (await stat(join(f.root, "state.json"))).mtimeMs;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.extract).toHaveBeenCalledOnce();
    expect((await stat(join(f.root, "state.json"))).mtimeMs).toBe(before);
    expect((await f.service.status()).pendingObservations).toBe(1);
    expect((await f.service.status()).nextAnalysisAt).toBe("2026-09-25T09:59:00.000Z");
  });

  test("processing finishes after collection closes and signals new knowledge", async () => {
    const f = await fixture();
    await f.service.configure({ enabled: true, processingPaused: false, modelProfileId: "local" });
    f.observe("1");
    await f.service.configure({ enabled: false });
    await Promise.all([f.service.flush(), f.service.flush()]);
    expect(f.extract).toHaveBeenCalledOnce();
    expect(f.proactive.knowledgeChanged).toHaveBeenCalledOnce();
  });

  test("rejects unavailable proactive-only profiles before persisting preferences", async () => {
    const f = await fixture();
    await f.service.configure({ enabled: false, processingPaused: true, modelProfileId: "learning" });
    const before = await readFile(join(f.root, "state.json"), "utf8");
    f.validateProfile.mockImplementation(() => { throw new Error("learning_model_profile_unavailable"); });
    await expect(f.service.configure({ proactiveEnabled: true, proactiveModelProfileId: "missing" }))
      .rejects.toThrow("learning_model_profile_unavailable");
    expect(await readFile(join(f.root, "state.json"), "utf8")).toBe(before);
    expect((await f.service.status()).preferences.proactiveEnabled).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
  });

  test("receipt capacity blocks taking and journaling the waiting observations", async () => {
    const f = await fixture({ reviewAdmission: async () => ({ available: false,
      reason: "learning_receipt_capacity", retryAt: "2026-09-25T09:59:00Z" }) });
    await f.service.configure({ enabled: true, processingPaused: false, modelProfileId: "local", analysisIntervalMinutes: 1 });
    f.observe("1");
    const before = await readFile(join(f.root, "state.json"), "utf8");
    await f.service.flush();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.extract).not.toHaveBeenCalled(); expect(await f.service.batches()).toEqual([]);
    expect(await readFile(join(f.root, "state.json"), "utf8")).toBe(before);
    expect((await f.service.status()).reason).toBe("learning_receipt_capacity");
  });
});
