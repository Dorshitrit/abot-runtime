import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { PassiveLearningConnection, PassiveLearningModel } from "../passive-learning/contracts.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "learning-restart-"));
  let now = Date.parse("2026-09-28T10:00:00Z");
  const observation = (id: string) => ({
    id, deviceId: "device", sequence: 1, timestamp: new Date(now).toISOString(),
    source: { app: "editor", windowId: "window" }, content: "Working on a project",
    kind: "view" as const, extraction: "ax" as const, coverage: "partial" as const,
  });
  await createLearningStateStore(directory).write({
    schemaVersion: 1,
    preferences: { ...DEFAULT_LEARNING_PREFERENCES, enabled: true,
      processingPaused: true, modelProfileId: "model", proactiveEnabled: true },
    batches: [{ id: "pending", generation: "previous", status: "pending",
      createdAt: new Date(now).toISOString(), recordIds: [], observations: [observation("retained")] }],
  });
  const extract = vi.fn<PassiveLearningModel["extract"]>(async () => []);
  const validateProfile = vi.fn();
  const memory = {
    status: vi.fn(async () => ({ enabled: true, available: true })),
    saveObservationBatch: vi.fn(async ({ batchId }: { batchId: string }) => ({
      batchId, recordIds: [], createdAt: new Date(now).toISOString(),
    })),
    observationBatchReceipt: vi.fn(async () => undefined),
  } as unknown as LongTermMemoryService;
  const connections: Parameters<PassiveLearningConnection>[0][] = [];
  const close = vi.fn();
  const connect = vi.fn<PassiveLearningConnection>(async (input) => {
    connections.push(input);
    return { close };
  });
  const service = createPassiveLearningService({ directory, ownerId: "env", memory,
    model: { validateProfile, extract }, connect, now: () => now });
  cleanup.push(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
  await service.start();
  function blocked(connection = connections.at(-1)!) {
    connection.onEvent({ type: "status", ownerId: "env", deviceId: "device",
      leaseId: connection.leaseId, state: "permission_required",
      reason: "macos_accessibility_permission_timeout" });
  }
  function observe() {
    const connection = connections.at(-1)!;
    connection.onEvent({ type: "observation", ownerId: "env", deviceId: "device",
      leaseId: connection.leaseId, observation: observation("queued") });
  }
  return { service, connections, connect, close, extract, validateProfile, memory, blocked, observe,
    readState: () => readFile(join(directory, "state.json"), "utf8"),
    setNow: (value: number) => { now = value; } };
}

describe("permission-blocked collection restart", () => {
  test("replaces only the blocked lease, preserving preferences, pending work and stored state", async () => {
    const f = await fixture();
    f.observe();
    f.blocked();
    const previous = f.connections[0];
    const before = await f.service.status();
    const stored = await f.readState();
    const batches = await f.service.batches();

    const result = await f.service.restartCollection!();

    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.close).toHaveBeenCalledOnce();
    expect(previous.abortSignal.aborted).toBe(true);
    expect(f.connections[1].leaseId).not.toBe(previous.leaseId);
    expect(result).toMatchObject({ collectionState: "starting", pendingObservations: 2,
      preferences: before.preferences });
    expect(result.collectionReason).toBeUndefined();
    expect(await f.service.batches()).toEqual(batches);
    expect(await f.readState()).toBe(stored);
    expect(f.extract).not.toHaveBeenCalled();
    expect(f.validateProfile).not.toHaveBeenCalled();
    expect(f.memory.saveObservationBatch).not.toHaveBeenCalled();
    f.blocked(previous);
    expect((await f.service.status()).collectionState).toBe("starting");
    const current = f.connections[1];
    current.onEvent({ type: "status", ownerId: "env", deviceId: "device",
      leaseId: current.leaseId, state: "partial", reason: "ax_application_coverage" });
    expect((await f.service.status()).collectionState).toBe("partial");
  });

  test("does not interrupt processing already in progress", async () => {
    const f = await fixture();
    let finish!: (value: []) => void;
    f.extract.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await f.service.configure({ processingPaused: false });
    f.blocked();
    const processing = f.service.flush();
    await vi.waitFor(() => expect(f.extract).toHaveBeenCalledOnce());
    const signal = f.extract.mock.calls[0][0].signal;
    const result = await f.service.restartCollection!();
    expect(signal.aborted).toBe(false);
    expect(result.processing).toBe(true);
    expect(result.preferences.processingPaused).toBe(false);
    finish([]);
    await processing;
    expect(f.extract).toHaveBeenCalledOnce();
  });

  test.each(["off", "stopped", "outside_window", "healthy"])(
    "a stale click does not open a collector when %s", async (condition) => {
      const f = await fixture();
      f.blocked();
      if (condition === "off") await f.service.configure({ enabled: false });
      if (condition === "stopped") await f.service.stop();
      if (condition === "outside_window") {
        await f.service.configure({ collectionWindow: { start: "09:00", end: "11:00", timeZone: "UTC" } });
        f.setNow(Date.parse("2026-09-28T12:00:00Z"));
      }
      if (condition === "healthy") {
        const connection = f.connections[0];
        connection.onEvent({ type: "status", ownerId: "env", deviceId: "device",
          leaseId: connection.leaseId, state: "partial", reason: "ax_application_coverage" });
      }
      const before = await f.service.status();
      const opened = f.connect.mock.calls.length;
      await f.service.restartCollection!();
      expect(f.connect).toHaveBeenCalledTimes(opened);
      expect((await f.service.status()).preferences).toEqual(before.preferences);
    },
  );

  test("serializes simultaneous restarts and stop behind the single collection owner", async () => {
    const f = await fixture();
    f.blocked();
    await Promise.all([f.service.restartCollection!(), f.service.restartCollection!(), f.service.stop()]);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.connections.every((connection) => connection.abortSignal.aborted)).toBe(true);
    expect((await f.service.status()).collectionState).toBe("off");
  });

  test("an unavailable transport reports failure without losing queued observations", async () => {
    const f = await fixture();
    f.observe();
    f.blocked();
    f.connect.mockRejectedValueOnce(new Error("learning_host_unavailable"));
    const result = await f.service.restartCollection!();
    expect(result).toMatchObject({ collectionState: "unavailable",
      collectionReason: "learning_host_unavailable", pendingObservations: 2 });
    expect(f.extract).not.toHaveBeenCalled();
  });
});
