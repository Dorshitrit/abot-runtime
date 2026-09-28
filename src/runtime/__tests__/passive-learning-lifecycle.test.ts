import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type {
  PassiveLearningConnection,
  PassiveLearningModel,
  LearningBatch,
} from "../passive-learning/contracts.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import {
  createLearningStateStore,
  DEFAULT_LEARNING_PREFERENCES,
} from "../passive-learning/store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(batches: readonly LearningBatch[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "learning-lifecycle-"));
  await createLearningStateStore(directory).write({
    schemaVersion: 1,
    preferences: {
      ...DEFAULT_LEARNING_PREFERENCES,
      enabled: true,
      processingPaused: true,
      modelProfileId: "model",
    },
    batches,
  });
  const memoryStatus = vi.fn(async () => ({ enabled: true, available: true }));
  const receipt = vi.fn(async () => { throw new Error("memory_unavailable"); });
  const memory = {
    status: memoryStatus,
    saveObservationBatch: vi.fn(),
    observationBatchReceipt: receipt,
  } as unknown as LongTermMemoryService;
  const validateProfile = vi.fn<(profileId: string) => void>(() => {});
  const extract = vi.fn<PassiveLearningModel["extract"]>(async () => []);
  const connections: Parameters<PassiveLearningConnection>[0][] = [];
  const closeConnection = vi.fn();
  const connect = vi.fn<PassiveLearningConnection>(async (input) => {
    connections.push(input);
    return { close: closeConnection };
  });
  const service = createPassiveLearningService({
    directory,
    ownerId: "environment",
    memory,
    model: { validateProfile, extract },
    connect,
  });
  cleanup.push(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  function observe(
    deviceId: string,
    sequence: number,
    connection = connections.at(-1)!,
  ) {
    connection.onEvent({
      type: "observation",
      deviceId,
      ownerId: "environment",
      leaseId: connection.leaseId,
      observation: {
        id: `${deviceId}-${sequence}`,
        timestamp: new Date().toISOString(),
        sequence,
        source: { app: "editor", windowId: "window" },
        content: `Working context ${deviceId} ${sequence}`,
        kind: "view",
        extraction: "uia",
        coverage: "complete",
      },
    });
  }
  return {
    service,
    memoryStatus,
    validateProfile,
    extract,
    connect,
    connections,
    closeConnection,
    observe,
    receipt,
  };
}

describe("passive learning lifecycle collection independence", () => {
  it("opens paused collection with pending history without consulting unavailable memory receipts", async () => {
    const timestamp = new Date().toISOString();
    const f = await fixture([{ id: "pending", generation: "old", createdAt: timestamp,
      status: "pending", recordIds: [], observations: [{ id: "old", deviceId: "device-a",
        timestamp, sequence: 1, source: { app: "editor", windowId: "window" },
        content: "Earlier work", kind: "view", extraction: "uia", coverage: "complete" }] }]);
    await f.service.start();
    expect(f.receipt).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledOnce();
    f.observe("device-a", 2);
    expect((await f.service.status()).pendingObservations).toBe(2);
    expect(f.extract).not.toHaveBeenCalled();
  });
  it.each(["model", "memory"])(
    "starts saved collection while analysis is paused and %s is unavailable",
    async (dependency) => {
      const test = await fixture();
      if (dependency === "model") {
        test.validateProfile.mockImplementation(() => {
          throw new Error("learning_model_profile_unavailable");
        });
      } else {
        test.memoryStatus.mockResolvedValue({
          enabled: false,
          available: false,
        });
      }
      await test.service.start();
      expect(test.connect).toHaveBeenCalledOnce();
      expect(test.validateProfile).not.toHaveBeenCalled();
      expect(test.memoryStatus).not.toHaveBeenCalled();
      await test.service.configure({ enabled: false });
      await test.service.configure({ enabled: true });
      expect(test.connect).toHaveBeenCalledTimes(2);
      expect(test.validateProfile).not.toHaveBeenCalled();
      expect(test.memoryStatus).not.toHaveBeenCalled();
      test.observe("device-a", 1);
      await test.service.flush();
      expect(await test.service.status()).toMatchObject({
        preferences: { enabled: true, processingPaused: true },
        pendingObservations: 1,
        processing: false,
      });
      expect(test.extract).not.toHaveBeenCalled();

      await expect(
        test.service.configure({ processingPaused: false }),
      ).rejects.toThrow(
        dependency === "model"
          ? "learning_model_profile_unavailable"
          : "learning_memory_unavailable",
      );
      expect((await test.service.status()).preferences.processingPaused).toBe(
        true,
      );
      expect(test.connections.at(-1)!.abortSignal.aborted).toBe(false);
      test.observe("device-a", 2);
      expect((await test.service.status()).pendingObservations).toBe(2);
    },
  );

  it("rebinds the same service to the currently paired device after stop and start", async () => {
    const test = await fixture();
    await test.service.start();
    const previous = test.connections[0]!;
    test.observe("device-a", 1);
    expect((await test.service.status()).deviceId).toBe("device-a");
    await test.service.stop();
    expect((await test.service.status()).deviceId).toBeUndefined();
    expect(previous.abortSignal.aborted).toBe(true);
    await test.service.start();
    expect(test.connect).toHaveBeenCalledTimes(2);
    expect(test.connections[1]!.leaseId).not.toBe(previous.leaseId);
    test.observe("device-a", 2, previous);
    test.observe("device-b", 1);
    expect(await test.service.status()).toMatchObject({
      deviceId: "device-b",
      state: "starting",
      pendingObservations: 2,
    });
    expect((await test.service.status()).reason).toBeUndefined();
    expect(test.connections[1]!.abortSignal.aborted).toBe(false);
  });

  it("still rejects an unexpected device change within the active collection lease", async () => {
    const test = await fixture();
    await test.service.start();
    test.observe("device-a", 1);
    test.observe("device-b", 1);
    expect(await test.service.status()).toMatchObject({
      deviceId: "device-a",
      state: "unavailable",
      reason: "learning_device_changed",
      pendingObservations: 1,
    });
    expect(test.connections[0]!.abortSignal.aborted).toBe(true);
    expect(test.closeConnection).toHaveBeenCalledOnce();
  });
});
