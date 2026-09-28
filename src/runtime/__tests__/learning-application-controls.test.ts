import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSIVE_OBSERVATION_RETENTION_MS } from "../../shared/passive-observation.js";
import { createFileLongTermMemoryRepository } from "../adapters/long-term-memory/file-repository.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import type { PassiveLearningConnection, PassiveLearningModel, PassiveLearningService } from "../passive-learning/contracts.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createLearningStateStore } from "../passive-learning/store.js";
import * as logger from "../observability/debug-logger.js";

type Review = NonNullable<PassiveLearningModel["review"]>;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function decisions(input: Parameters<Review>[0]): Awaited<ReturnType<Review>> {
  return input.observations.map((observation) => ({
    action: "create", targetKind: "candidate", targetId: null, targetVersion: null,
    content: `Development context from ${observation.id}.`, tags: [], score: 85,
    reason: "Observed workflow", certainty: "observed", reinforced: true,
    observationIds: [observation.id], mergedCandidateIds: [], reconsiderAt: null,
  }));
}

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  vi.spyOn(logger, "traceDebug").mockImplementation(() => {});
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-proactive-memory-20260925/application-controls-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "fixture-"));
  const storedMemory = createLongTermMemoryService({
    repository: createFileLongTermMemoryRepository(join(directory, "memory")), enabled: true, emitClientEvents: false,
    embeddings: { async embed({ texts }) {
      return { modelFingerprint: "test", dimensions: 2, vectors: texts.map(() => [1, 0]) };
    } },
  });
  const memory = { ...storedMemory, learning: { ...storedMemory.learning! } };
  const review = vi.fn<Review>(async (input) => decisions(input));
  const model: PassiveLearningModel = { validateProfile() {}, extract: vi.fn(async () => []), review };
  const resourceUsage = vi.fn(async () => ({ schemaVersion: 1 as const, timeZone: "UTC",
    startedAt: Date.now(), resetsAt: Date.now() + 86_400_000, modelCalls: 0, embeddingCalls: 0,
    embeddingCharacters: 0, activeCalls: 0 }));
  let source!: Parameters<PassiveLearningConnection>[0];
  const connect = vi.fn<PassiveLearningConnection>(async (input) => { source = input; return { close() {} }; });
  const services: PassiveLearningService[] = [];
  const releases: (() => void)[] = [];
  const journal = createLearningStateStore(join(directory, "learning"));
  const open = () => {
    const service = createPassiveLearningService({
      directory: join(directory, "learning"), ownerId: "environment", memory, model, connect, batchDelayMs: 60_000,
      backgroundDependencies: () => ({ memory, model, resourceUsage }),
    });
    services.push(service);
    return service;
  };
  cleanup.push(async () => {
    for (const release of releases) release();
    for (const service of services) await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  const observe = (id: string, app: string) => source.onEvent({
    type: "observation", deviceId: "device", ownerId: "environment", leaseId: source.leaseId,
    observation: { id, timestamp: new Date().toISOString(), sequence: ++sequence,
      source: { app, windowId: "window" }, content: `Evidence for ${id}`,
      kind: "view", extraction: "uia", coverage: "complete" },
  });
  const enable = async (service: PassiveLearningService) => {
    await service.start();
    await service.configure({ enabled: true, processingPaused: false, modelProfileId: "model" });
  };
  function blockNextIgnoringAbort() {
    let finish!: () => void;
    review.mockImplementationOnce((input) => new Promise((resolve) => { finish = () => resolve(decisions(input)); }));
    const release = () => finish?.();
    releases.push(release);
    return release;
  }
  return { open, enable, observe, memory, review, resourceUsage, journal, connect, blockNextIgnoringAbort,
    source: () => source,
    reviewedIds: () => review.mock.calls.flatMap(([input]) => input.observations.map(({ id }) => id)),
  };
}

describe("independent learning application controls", () => {
  it("matches collection exclusions case-insensitively without excluding already collected work from processing", async () => {
    const f = await fixture();
    const service = f.open();
    await f.enable(service);
    f.observe("before-collection-exclusion", "Firefox");
    await service.configure({ excludedApplications: [" firefox "] });
    f.observe("ignored-after-collection-exclusion", "FiReFoX");
    f.observe("other-application", "Editor");
    await service.flush();
    expect(f.reviewedIds()).toEqual(["before-collection-exclusion", "other-application"]);
    expect(f.source().excludedApplications).toEqual(["firefox"]);
    expect((await service.status()).preferences.processingExcludedApplications).toEqual([]);
    expect(await f.memory.learning!.list()).toHaveLength(2);
  });

  it("processes allowed queued observations and retains blocked ones until explicitly unblocked", async () => {
    const f = await fixture();
    const service = f.open();
    await f.enable(service);
    await service.configure({ processingExcludedApplications: ["FIREFOX"] });
    f.observe("held-one", "Firefox");
    f.observe("allowed", "Editor");
    f.observe("held-two", "firefox");
    expect(await service.status()).toMatchObject({ pendingObservations: 1, blockedObservations: 2 });
    await service.flush();
    expect(f.reviewedIds()).toEqual(["allowed"]);
    expect(await service.status()).toMatchObject({ pendingObservations: 0, blockedObservations: 2, preferences: { excludedApplications: [] } });
    await service.configure({ processingExcludedApplications: [] });
    expect(await service.status()).toMatchObject({ pendingObservations: 2, blockedObservations: 0 });
    await service.flush();
    expect(f.reviewedIds()).toEqual(["allowed", "held-one", "held-two"]);
    expect((await service.status()).pendingObservations).toBe(0);
    expect(await f.memory.learning!.list()).toHaveLength(3);
  });

  it("does not poll resources or models for blocked-only evidence and expires it on the existing deadline", async () => {
    const f = await fixture();
    const service = f.open();
    await f.enable(service);
    await service.configure({ processingExcludedApplications: ["Firefox"] });
    f.observe("held-until-retention", "firefox");
    expect((await service.status()).nextAnalysisAt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    f.resourceUsage.mockClear();
    await service.flush();
    await vi.advanceTimersByTimeAsync(PASSIVE_OBSERVATION_RETENTION_MS - 1);
    expect(f.review).not.toHaveBeenCalled();
    expect(f.resourceUsage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.resourceUsage).not.toHaveBeenCalled();
    expect(f.review).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect((await service.status()).pendingObservations).toBe(0);
  });

  it("durably partitions mixed pending work without refreshing timestamps or repeating the allowed subset", async () => {
    const f = await fixture();
    const service = f.open();
    await f.enable(service);
    await service.configure({ processingPaused: true });
    f.observe("held-from-disk", "Firefox");
    vi.setSystemTime(Date.now() + 1_000);
    f.observe("allowed-from-disk", "Editor");
    await service.configure({ enabled: false });
    const original = (await f.journal.read()).batches[0]!;
    expect(original.observations).toHaveLength(2);
    vi.setSystemTime(Date.now() + 600_000);
    await service.configure({ processingPaused: false, processingExcludedApplications: ["firefox"] });
    expect(await service.status()).toMatchObject({ pendingObservations: 1, blockedObservations: 1 });
    await service.flush();
    const disk = (await f.journal.read()).batches;
    expect(disk).toHaveLength(2);
    expect(disk.find(({ id }) => id === original.id)).toMatchObject({ status: "reviewed", observations: [original.observations[1]] });
    const held = disk.find(({ id }) => id !== original.id)!;
    expect(held).toMatchObject({ status: "pending", createdAt: original.createdAt, observations: [original.observations[0]] });
    expect(disk.every(({ createdAt }) => createdAt === original.createdAt)).toBe(true);
    expect(f.reviewedIds()).toEqual(["allowed-from-disk"]);
    expect(await service.status()).toMatchObject({ pendingObservations: 0, blockedObservations: 1 });
    await service.configure({ processingExcludedApplications: [] });
    await service.flush();
    expect(f.reviewedIds()).toEqual(["allowed-from-disk", "held-from-disk"]);
    expect(f.review.mock.calls[1]![0].batchId).toBe(held.id);
    expect(await f.memory.learning!.list()).toHaveLength(2);
    expect((await service.status()).pendingObservations).toBe(0);
  });

  it("aborts affected active work and rejects its late output while preserving the batch for later resumption", async () => {
    const f = await fixture();
    const service = f.open();
    await f.enable(service);
    const finish = f.blockNextIgnoringAbort();
    f.observe("active-affected", "Firefox");
    const running = service.flush();
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledOnce());
    const { signal, batchId } = f.review.mock.calls[0]![0];
    let configured = false;
    const configuration = service.configure({ processingExcludedApplications: ["FIREFOX"] }).then(() => { configured = true; });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(configured).toBe(false);
    expect((await f.memory.list()).total).toBe(0);
    expect(await f.memory.learning!.list()).toEqual([]);
    finish();
    await Promise.all([configuration, running]);
    expect(await service.batch(batchId)).toMatchObject({ status: "pending", reason: "learning_application_processing_excluded" });
    expect(await f.memory.learning!.receipt(batchId)).toBeUndefined();
    expect((await f.memory.list()).total).toBe(0);
    expect(await f.memory.learning!.list()).toEqual([]);
    await service.configure({ processingExcludedApplications: [] });
    await service.flush();
    expect(f.review.mock.calls[1]![0].batchId).toBe(batchId);
    expect(await f.memory.learning!.list()).toHaveLength(1);
  });

  it("does not abort an unrelated application already being processed", async () => {
    const f = await fixture();
    const service = f.open();
    await f.enable(service);
    const finish = f.blockNextIgnoringAbort();
    f.observe("active-unaffected", "Editor");
    const running = service.flush();
    await vi.waitFor(() => expect(f.review).toHaveBeenCalledOnce());
    const signal = f.review.mock.calls[0]![0].signal;
    await service.configure({ processingExcludedApplications: ["Firefox"] });
    expect(signal.aborted).toBe(false);
    expect((await service.status()).processing).toBe(true);
    finish();
    await running;
    expect(f.review).toHaveBeenCalledOnce();
    expect(await f.memory.learning!.list()).toHaveLength(1);
  });

  it("preserves exclusion preferences and held observations across restart, then resumes each observation once", async () => {
    const f = await fixture();
    const first = f.open();
    await f.enable(first);
    await first.configure({ excludedApplications: ["Browser"], processingExcludedApplications: ["EDITOR"], analysisIntervalMinutes: 17 });
    f.observe("held-across-restart", "editor");
    await first.stop();
    expect((await f.journal.read()).preferences).toMatchObject({ excludedApplications: ["Browser"],
      processingExcludedApplications: ["EDITOR"], analysisIntervalMinutes: 17 });
    const restarted = f.open();
    await restarted.start();
    expect(await restarted.status()).toMatchObject({ pendingObservations: 0, blockedObservations: 1,
      preferences: { excludedApplications: ["Browser"], processingExcludedApplications: ["EDITOR"], analysisIntervalMinutes: 17 } });
    expect((await restarted.status()).nextAnalysisAt).toBeUndefined();
    f.resourceUsage.mockClear();
    await restarted.flush();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.resourceUsage).not.toHaveBeenCalled();
    await restarted.configure({ processingExcludedApplications: [] });
    await restarted.flush();
    expect(f.reviewedIds()).toEqual(["held-across-restart"]);
    expect(await f.memory.learning!.list()).toHaveLength(1);
    expect((await restarted.status()).preferences.excludedApplications).toEqual(["Browser"]);
    expect((await restarted.status()).pendingObservations).toBe(0);
  });

  it.each([["current", false], ["legacy", false], ["current", true], ["legacy", true]])(
    "reconciles a %s receipt on blocked processing resume (interactive: %s)", async (namespace, interactive) => {
    const f = await fixture(); const first = f.open(); await f.enable(first);
    await first.configure({ processingPaused: true, processingExcludedApplications: ["Editor"] });
    f.observe("committed-before-crash", "Editor"); await first.stop();
    const batch = (await f.journal.read()).batches[0]!;
    const receipt = { batchId: batch.id, recordIds: ["already-saved"], candidateIds: [], removedCandidateCount: 0,
      createdAt: batch.createdAt, expiresAt: new Date(Date.now() + PASSIVE_OBSERVATION_RETENTION_MS).toISOString() };
    const read = namespace === "current"
      ? vi.spyOn(f.memory.learning!, "receipt").mockResolvedValue(receipt)
      : vi.spyOn(f.memory, "observationBatchReceipt").mockResolvedValue(receipt);
    const restarted = f.open(); await restarted.start();
    expect(read).not.toHaveBeenCalled();
    expect(await restarted.status()).toMatchObject({ pendingObservations: 0, blockedObservations: 1 });
    const release = interactive ? restarted.beginInteractive() : undefined;
    await restarted.configure({ processingPaused: false });
    expect(await restarted.status()).toMatchObject({ pendingObservations: 0, blockedObservations: 0 });
    expect((await f.journal.read()).batches).toMatchObject([{ id: batch.id, status: "saved", recordIds: ["already-saved"] }]);
    expect(f.review).not.toHaveBeenCalled();
    release?.();
  });
});
