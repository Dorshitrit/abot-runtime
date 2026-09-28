import { afterEach, describe, expect, it, vi } from "vitest";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type {
  LearningBatch,
  PassiveLearningConnection,
  PassiveLearningPreferences,
  PassiveLearningService,
} from "../passive-learning/contracts.js";
import { LearningJournal } from "../passive-learning/journal.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import {
  createLearningStateStore,
  DEFAULT_LEARNING_PREFERENCES,
  type LearningState,
} from "../passive-learning/store.js";

vi.mock("../passive-learning/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../passive-learning/store.js")>()),
  createLearningStateStore: vi.fn(),
}));

const services: PassiveLearningService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function preferences(): PassiveLearningPreferences {
  return {
    ...DEFAULT_LEARNING_PREFERENCES,
    enabled: true,
    processingPaused: false,
    modelProfileId: "model",
  };
}

function pendingBatch(): LearningBatch {
  const timestamp = new Date().toISOString();
  return {
    id: "batch",
    createdAt: timestamp,
    generation: "generation",
    status: "pending",
    recordIds: [],
    observations: [
      {
        id: "observation",
        timestamp,
        sequence: 1,
        deviceId: "device",
        source: { app: "editor", windowId: "window" },
        content: "Development notes",
        kind: "view",
        extraction: "uia",
        coverage: "complete",
      },
    ],
  };
}

function storeFixture() {
  let persisted: LearningState = {
    schemaVersion: 1,
    preferences: preferences(),
    batches: [],
  };
  const read = vi.fn(async () => persisted);
  const write = vi.fn(async (state: LearningState) => {
    persisted = state;
  });
  vi.mocked(createLearningStateStore).mockReturnValue({ read, write });
  return { read, write, persisted: () => persisted };
}

function journalFixture() {
  const store = storeFixture();
  const journal = new LearningJournal({
    directory: "mock-journal",
    now: Date.now,
    preferences,
    changed: vi.fn(),
    failed: vi.fn(),
  });
  return { store, journal };
}

describe("learning control persistence ordering", () => {
  it("backs off failed journal writes and cancels retries on stop", async () => {
    vi.useFakeTimers();
    const { store, journal } = journalFixture();
    await journal.load();
    await journal.start();
    store.write.mockRejectedValue(new Error("Disk full"));
    await expect(journal.replace(pendingBatch())).rejects.toThrow("learning_storage_unavailable");
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const count = store.write.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(store.write).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.write).toHaveBeenCalledTimes(count + 1);
    }
    journal.stop();
    const count = store.write.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.write).toHaveBeenCalledTimes(count);
  });

  it("retains dequeued evidence when the processing transition cannot be persisted", async () => {
    vi.useFakeTimers();
    const store = storeFixture();
    let source!: Parameters<PassiveLearningConnection>[0];
    const extract = vi.fn(async () => []);
    const saveObservationBatch = vi.fn(async () => ({ recordIds: [] }));
    const service = createPassiveLearningService({
      directory: "mock-service",
      ownerId: "environment",
      memory: {
        status: async () => ({ enabled: true, available: true }),
        saveObservationBatch,
      } as unknown as LongTermMemoryService,
      model: { validateProfile() {}, extract },
      connect: async (input) => {
        source = input;
        return { close() {} };
      },
      batchDelayMs: 1_000,
    });
    services.push(service);
    await service.start();
    source.onEvent({
      type: "observation",
      deviceId: "device",
      ownerId: "environment",
      leaseId: source.leaseId,
      observation: pendingBatch().observations[0]!,
    });
    const write = store.write.getMockImplementation()!;
    store.write.mockRejectedValue(new Error("Disk full"));
    await service.flush();
    expect(extract).not.toHaveBeenCalled();
    expect((await service.status()).pendingObservations).toBe(1);
    const batch = (await service.batches())[0]!;
    expect(batch).toMatchObject({
      status: "pending",
      reason: "learning_storage_unavailable",
    });

    source.onEvent({ type: "status", deviceId: "device", ownerId: "environment",
      leaseId: source.leaseId, state: "partial", reason: "uia_application_coverage" });
    expect(await service.status()).toMatchObject({ state: "failed", reason: "learning_storage_unavailable" });
    store.write.mockImplementation(write);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.persisted().batches[0]).toMatchObject({
      id: batch.id,
      status: "pending",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(extract).toHaveBeenCalledOnce();
    expect(saveObservationBatch).toHaveBeenCalledOnce();
    expect((await service.batches())[0]).toMatchObject({
      id: batch.id,
      status: "discarded",
    });
    expect(await service.status()).toMatchObject({ state: "partial", reason: "uia_application_coverage" });
  });

  it("keeps a successful preference change when a background journal update was queued during its write", async () => {
    const { store, journal } = journalFixture();
    await journal.load();
    const gate = deferred();
    store.write.mockImplementationOnce(async () => gate.promise);
    const next = { ...preferences(), enabled: false };
    const configuration = journal.persist(next);
    await vi.waitFor(() => expect(store.write).toHaveBeenCalledOnce());
    const background = journal.replace(pendingBatch());
    gate.resolve();
    await configuration;
    await background;
    expect(store.write.mock.calls[1]?.[0].preferences).toEqual(next);
    expect(store.persisted()).toMatchObject({
      preferences: next,
      batches: [{ id: "batch" }],
    });
  });

  it("does not apply a failed preference change through a later background write", async () => {
    const { store, journal } = journalFixture();
    await journal.load();
    const gate = deferred();
    store.write.mockImplementationOnce(async () => gate.promise);
    const next = { ...preferences(), enabled: false, processingPaused: true };
    const configuration = journal.persist(next);
    const failure = expect(configuration).rejects.toThrow(
      "learning_storage_unavailable",
    );
    await vi.waitFor(() => expect(store.write).toHaveBeenCalledOnce());
    const background = journal.replace(pendingBatch());
    gate.reject(new Error("Disk full"));
    await failure;
    await background;
    expect(store.write.mock.calls[1]?.[0].preferences).toEqual(preferences());
    expect(store.persisted().preferences).toEqual(preferences());
    expect(journal.storageAvailable).toBe(true);
  });

  it("keeps every queued observation in the journal when preservation fails beyond one batch", async () => {
    const store = storeFixture();
    let source!: Parameters<PassiveLearningConnection>[0];
    const memory = {
      status: async () => ({ enabled: true, available: true }),
      saveObservationBatch: vi.fn(),
    } as unknown as LongTermMemoryService;
    const service = createPassiveLearningService({
      directory: "mock-service",
      ownerId: "environment",
      memory,
      model: { validateProfile() {}, extract: vi.fn() },
      connect: async (input) => {
        source = input;
        return { close() {} };
      },
      batchDelayMs: 3_600_000,
    });
    services.push(service);
    await service.start();
    for (let sequence = 1; sequence <= 17; sequence++) {
      source.onEvent({
        type: "observation",
        deviceId: "device",
        ownerId: "environment",
        leaseId: source.leaseId,
        observation: {
          id: `observation-${sequence}`,
          timestamp: new Date().toISOString(),
          sequence,
          source: { app: "editor", windowId: "window" },
          content: `Development note ${sequence}`,
          kind: "view",
          extraction: "uia",
          coverage: "complete",
        },
      });
    }
    const save = store.write.getMockImplementation()!;
    store.write
      .mockImplementationOnce(save)
      .mockRejectedValueOnce(new Error("Disk full"));
    await expect(service.configure({ enabled: false })).rejects.toThrow(
      "learning_storage_unavailable",
    );
    expect((await service.status()).pendingObservations).toBe(17);
    expect(
      (await service.batches())
        .map((batch) => batch.observationCount)
        .sort((a, b) => a - b),
    ).toEqual([1, 16]);
    await service.configure({ processingPaused: true });
    expect(
      store.persisted().batches.flatMap((batch) => batch.observations),
    ).toHaveLength(17);
    expect(store.persisted().preferences).toMatchObject({
      enabled: false,
      processingPaused: true,
    });
  });
});
