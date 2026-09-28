import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import type { PassiveLearningConnection, PassiveLearningPreferences, PassiveLearningService } from "../passive-learning/contracts.js";
import { createPassiveLearningService } from "../passive-learning/service.js";
import { createLearningStateStore, DEFAULT_LEARNING_PREFERENCES, normalizeLearningPreferences } from "../passive-learning/store.js";
import { readLearningPreferencesInput } from "../local-host/learning-preferences-input.js";

const allowed = { collection: true, learning: true, proactive: true };
const denied = { collection: false, learning: false, proactive: false };
const stopped = { enabled: false, processingPaused: true, proactiveEnabled: false };
const running = { enabled: true, processingPaused: false, proactiveEnabled: true };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe("saved Spark authorization", () => {
  test("granting permission preserves the stopped switches; stopping does not erase permission", () => {
    const configured = normalizeLearningPreferences({ activityPermissions: allowed }, DEFAULT_LEARNING_PREFERENCES);
    expect(configured).toMatchObject({ ...stopped, activityPermissions: allowed });
    const active = normalizeLearningPreferences(running, configured);
    expect(normalizeLearningPreferences(stopped, active)).toMatchObject({ ...stopped, activityPermissions: allowed });
  });

  test("authorizing an unconfigured legacy learner does not turn its stale pause bit into active work", () => {
    const legacy = { ...DEFAULT_LEARNING_PREFERENCES, processingPaused: false };
    const configured = normalizeLearningPreferences({ activityPermissions: allowed, modelProfileId: "learning" }, legacy);
    expect(configured).toMatchObject({ ...stopped, activityPermissions: allowed });
    expect(normalizeLearningPreferences({ processingPaused: false }, configured).processingPaused).toBe(false);
  });

  test("revoking permission stops only its activity", () => {
    const previous = { ...DEFAULT_LEARNING_PREFERENCES, ...running, activityPermissions: allowed, modelProfileId: "learning" };
    expect(normalizeLearningPreferences({ activityPermissions: { ...allowed, collection: false } }, previous))
      .toMatchObject({ enabled: false, processingPaused: false, proactiveEnabled: true });
    expect(normalizeLearningPreferences({ activityPermissions: denied }, previous)).toMatchObject(stopped);
  });

  test.each([{ enabled: true }, { processingPaused: false }, { proactiveEnabled: true }])(
    "an operational request cannot bypass denied permission: %j", (input) => {
      expect(() => normalizeLearningPreferences(input, { ...DEFAULT_LEARNING_PREFERENCES, activityPermissions: denied }))
        .toThrow("learning_activity_not_allowed");
    },
  );

  test.each([null, [], {}, { ...allowed, other: true }, { ...allowed, proactive: "true" }])(
    "rejects malformed permissions at the transport and persisted preference boundaries: %j", (value) => {
      const input = { activityPermissions: value } as unknown as Partial<PassiveLearningPreferences>;
      expect(() => readLearningPreferencesInput(input)).toThrow();
      expect(() => normalizeLearningPreferences(input, DEFAULT_LEARNING_PREFERENCES)).toThrow();
    },
  );

  test("transport accepts permissions without requiring the model to be repeated in each patch", () => {
    expect(readLearningPreferencesInput({ activityPermissions: allowed })).toEqual({ activityPermissions: allowed });
    expect(readLearningPreferencesInput({ processingPaused: false })).toEqual({ processingPaused: false });
  });

  test("old clients keep their existing switch contract until explicit permissions are saved", () => {
    const legacy = normalizeLearningPreferences({ enabled: true }, DEFAULT_LEARNING_PREFERENCES);
    expect(legacy.enabled).toBe(true);
    expect(legacy.activityPermissions).toBeUndefined();
    expect(normalizeLearningPreferences({ processingPaused: false, modelProfileId: "learning" }, legacy).processingPaused).toBe(false);
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "spark-permissions-"));
  const now = Date.parse("2026-09-28T10:00:00Z");
  const services: PassiveLearningService[] = [];
  const connections: Parameters<PassiveLearningConnection>[0][] = [];
  const close = vi.fn();
  const connect = vi.fn<PassiveLearningConnection>(async (input) => { connections.push(input); return { close }; });
  const extract = vi.fn(async () => []);
  const validateProfile = vi.fn((id: string) => {
    if (!["learning", "proactive"].includes(id)) throw new Error("learning_model_profile_unavailable");
  });
  const proactiveChanges = vi.fn();
  const memory = {
    status: async () => ({ enabled: true, available: true }), learning: {},
    saveObservationBatch: vi.fn(), observationBatchReceipt: async () => undefined,
  } as unknown as LongTermMemoryService;
  async function open() {
    const model = { validateProfile, extract };
    const service = createPassiveLearningService({ directory, ownerId: "env", memory, model, connect,
      now: () => now,
      backgroundDependencies: (context) => ({ memory, model, proactive: {
        start: async () => {}, stop: async () => {},
        preferencesChanged: async () => { proactiveChanges(context.preferences().proactiveEnabled); },
        knowledgeChanged() {}, beginInteractive: () => () => {},
        status: async () => ({ state: "off", proposals: [] }), dismiss: async () => {},
      } }),
    });
    services.push(service);
    await service.start();
    return service;
  }
  cleanup.push(async () => {
    for (const service of services) await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const service = await open();
  function observe() {
    const connection = connections.at(-1)!;
    connection.onEvent({ type: "observation", ownerId: "env", deviceId: "device", leaseId: connection.leaseId,
      observation: { id: "pending", sequence: 1, timestamp: new Date(now).toISOString(),
        source: { app: "editor", windowId: "window" }, content: "Working on a project",
        kind: "view", extraction: "ax", coverage: "partial" } });
  }
  return { service, open, connect, close, extract, validateProfile, proactiveChanges, observe,
    store: createLearningStateStore(directory) };
}

describe("Spark authorization through the existing service", () => {
  test("saving authorization validates profiles but starts no collection or model work", async () => {
    const f = await fixture();
    const result = await f.service.configure({ activityPermissions: allowed,
      modelProfileId: "learning", proactiveModelProfileId: "proactive" });
    expect(result.preferences).toMatchObject({ ...stopped, activityPermissions: allowed });
    expect(f.validateProfile.mock.calls).toEqual([["learning"], ["proactive"]]);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.extract).not.toHaveBeenCalled();
    expect(f.proactiveChanges).toHaveBeenLastCalledWith(false);
  });

  test.each([
    ["collection", "learning_model_required"], ["learning", "learning_model_required"], ["proactive", "proactive_model_required"],
  ] as const)("cannot authorize %s without its model", async (axis, reason) => {
    const f = await fixture();
    const before = (await f.service.status()).preferences;
    await expect(f.service.configure({ activityPermissions: { ...denied, [axis]: true } })).rejects.toThrow(reason);
    expect((await f.service.status()).preferences).toEqual(before);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.extract).not.toHaveBeenCalled();
  });

  test("rejects a removed model before saving permission", async () => {
    const f = await fixture();
    await expect(f.service.configure({ activityPermissions: allowed, modelProfileId: "missing" }))
      .rejects.toThrow("learning_model_profile_unavailable");
    expect((await f.store.read()).preferences.activityPermissions).toBeUndefined();
  });

  test("start, independent stop and restart preserve authorization, queued work and schedules", async () => {
    const f = await fixture();
    const window = { start: "09:00", end: "17:00", timeZone: "UTC" };
    await f.service.configure({ activityPermissions: allowed, modelProfileId: "learning", analysisWindow: window });
    await f.service.configure(running);
    f.observe();
    await f.service.configure({ enabled: false });
    expect(f.close).toHaveBeenCalledOnce();
    expect((await f.service.status()).preferences).toMatchObject({ activityPermissions: allowed,
      enabled: false, processingPaused: false, proactiveEnabled: true });
    await f.service.configure({ processingPaused: true });
    await f.service.configure({ proactiveEnabled: false });
    expect((await f.service.status()).pendingObservations).toBe(1);
    await f.service.stop();
    const resumed = await f.open();
    expect((await resumed.status()).preferences).toMatchObject({ ...stopped, activityPermissions: allowed, analysisWindow: window });
    await resumed.configure(running);
    expect((await resumed.status()).preferences).toMatchObject({ ...running, activityPermissions: allowed, analysisWindow: window });
    expect((await resumed.status()).pendingObservations).toBe(1);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.proactiveChanges).toHaveBeenLastCalledWith(true);
    expect(f.extract).not.toHaveBeenCalled();
  });

  test("revocation stops all running activities, persists denial and rejects reactivation", async () => {
    const f = await fixture();
    await f.service.configure({ activityPermissions: allowed, modelProfileId: "learning", ...running });
    f.observe();
    await f.service.configure({ activityPermissions: denied });
    expect((await f.service.status()).preferences).toMatchObject({ ...stopped, activityPermissions: denied });
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.proactiveChanges).toHaveBeenLastCalledWith(false);
    expect((await f.service.status()).pendingObservations).toBe(1);
    await expect(f.service.configure(running)).rejects.toThrow("learning_activity_not_allowed");
    expect((await f.store.read()).preferences).toMatchObject({ ...stopped, activityPermissions: denied });
  });

  test("proactive-only authorization and activation do not require a collection model or computer", async () => {
    const f = await fixture();
    await f.service.configure({ activityPermissions: { ...denied, proactive: true }, proactiveModelProfileId: "proactive" });
    await f.service.configure({ proactiveEnabled: true });
    expect((await f.service.status()).preferences).toMatchObject({ enabled: false, processingPaused: true, proactiveEnabled: true });
    expect(f.connect).not.toHaveBeenCalled();
  });

  test("stopping a legacy installation can preserve its permissions even after a model becomes unavailable", async () => {
    const f = await fixture();
    await f.service.configure({ ...running, modelProfileId: "learning" });
    f.validateProfile.mockImplementation(() => { throw new Error("learning_model_profile_unavailable"); });
    await f.service.configure({ ...stopped, activityPermissions: allowed });
    expect((await f.service.status()).preferences).toMatchObject({ ...stopped, activityPermissions: allowed });
    await expect(f.service.configure(running)).rejects.toThrow("learning_model_profile_unavailable");
    expect(f.connect).toHaveBeenCalledOnce();
  });
});
