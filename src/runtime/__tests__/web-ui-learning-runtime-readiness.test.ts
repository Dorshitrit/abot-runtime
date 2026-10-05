import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPassiveLearningController } from "../../web-ui/app/controllers/passive-learning-controller.js";
// @ts-expect-error Browser-only feature has no declaration surface.
import { createPassiveLearningFeature } from "../../web-ui/app/passive-learning-feature.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const status = (enabled = true) => ({ preferences: { enabled }, state: enabled ? "collecting" : "off" });

function fixture(initiallyReady = false) {
  let ready = initiallyReady;
  let visible = true;
  let environment = "dev";
  const timers = new Map<number, () => void>();
  let sequence = 0;
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ status: status() })),
    listPassiveLearningBatches: vi.fn(async () => ({ items: [{ id: "batch" }] })),
    listPassiveLearningCandidates: vi.fn(async () => ({ items: [{ id: "candidate" }] })),
    listModels: vi.fn(async () => ({ profiles: [{ id: "model" }] })),
    getSystemHostConnection: vi.fn(async () => ({ id: "host" })),
    loadPassiveLearningBatch: vi.fn(async (id: string) => ({ batch: { id } })),
    configurePassiveLearning: vi.fn(async () => ({ status: status() })),
    clearPassiveLearningPending: vi.fn(async () => ({ status: status() })),
    restartPassiveLearningCollection: vi.fn(async () => ({ status: status() })),
  };
  const controller = createPassiveLearningController({
    client, getEnvironmentId: () => environment, isRuntimeReady: () => ready,
    isVisible: () => visible, render: vi.fn(),
    setTimer: (callback: () => void) => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimer: (id: number) => timers.delete(id),
  });
  return { client, controller, timers, isReady: () => ready,
    setReady: (value: boolean) => { ready = value; },
    setVisible: (value: boolean) => { visible = value; },
    setEnvironment: (value: string) => { environment = value; } };
}

describe("learning Runtime readiness", () => {
  test.each(["home", "learning"])("does not read or mutate from %s while Runtime is unavailable", async workspace => {
    const f = fixture();
    f.controller.setWorkspace(workspace);
    f.controller.reconnect();
    f.controller.handleRealtime({ type: "learning.changed", environmentId: "dev" });
    f.controller.handleRealtime({ type: "system-host.changed" });
    await f.controller.refresh();
    await f.controller.selectBatch("batch");
    await f.controller.configure({ enabled: true });
    await f.controller.clearPending();
    await f.controller.restartCollection();
    for (const method of Object.values(f.client)) expect(method).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    expect(f.controller.snapshot()).toMatchObject({ status: null, models: [], statusError: "" });
  });

  test.each(["home", "learning"])("refreshes ready %s once with only that workspace's reads", async workspace => {
    const f = fixture();
    f.controller.setWorkspace(workspace);
    f.setReady(true); f.controller.runtimeAvailabilityChanged();
    await vi.waitFor(() => expect(f.controller.snapshot().status).not.toBeNull());
    f.controller.runtimeAvailabilityChanged();
    expect(f.client.loadPassiveLearning).toHaveBeenCalledExactlyOnceWith("dev");
    expect(f.client.listModels).toHaveBeenCalledTimes(workspace === "learning" ? 1 : 0);
    expect(f.client.listPassiveLearningBatches).toHaveBeenCalledTimes(workspace === "learning" ? 1 : 0);
    expect(f.client.listPassiveLearningCandidates).toHaveBeenCalledTimes(workspace === "learning" ? 1 : 0);
    expect(f.timers.size).toBe(0);
  });

  test.each(["hidden", "inactive"])("defers a ready transition until the %s view becomes active", async mode => {
    const f = fixture();
    f.setVisible(mode !== "hidden");
    f.controller.setWorkspace(mode === "inactive" ? "chat" : "learning");
    f.setReady(true); f.controller.runtimeAvailabilityChanged();
    await f.controller.refresh();
    expect(f.client.loadPassiveLearning).not.toHaveBeenCalled();
    expect(f.client.listModels).not.toHaveBeenCalled();
    f.setVisible(true);
    f.controller.setWorkspace("learning");
    f.controller.visibilityChanged();
    await vi.waitFor(() => expect(f.controller.snapshot().models).toEqual([{ id: "model" }]));
    expect(f.client.loadPassiveLearning).toHaveBeenCalledOnce();
  });

  test("a fresh ready generation does not wait for or accept earlier status/model/candidate results", async () => {
    const f = fixture(true);
    const old = deferred<{ status: ReturnType<typeof status> }>();
    f.client.loadPassiveLearning.mockReturnValueOnce(old.promise);
    f.client.listModels.mockResolvedValueOnce({ profiles: [{ id: "old-model" }] });
    f.client.listPassiveLearningCandidates.mockResolvedValueOnce({ items: [{ id: "old-candidate" }] });
    f.client.listPassiveLearningBatches.mockResolvedValueOnce({ items: [{ id: "old-batch" }] });
    f.controller.setWorkspace("learning");
    f.controller.handleRealtime({ type: "learning.changed", environmentId: "dev" });
    f.setReady(false); f.controller.runtimeAvailabilityChanged();
    expect(f.controller.snapshot()).toMatchObject({
      status: null, models: [], candidates: [], batches: [],
      loadingStatus: false, loadingBatches: false, loadingCandidates: false,
    });
    f.setReady(true); f.controller.runtimeAvailabilityChanged();
    await vi.waitFor(() => expect(f.controller.snapshot().models).toEqual([{ id: "model" }]));
    expect(f.client.loadPassiveLearning).toHaveBeenCalledTimes(2);
    old.resolve({ status: status(false) });
    await old.promise; await Promise.resolve();
    expect(f.controller.snapshot()).toMatchObject({
      status: status(), models: [{ id: "model" }],
      candidates: [{ id: "candidate" }], batches: [{ id: "batch" }],
    });
    expect(f.client.loadPassiveLearning).toHaveBeenCalledTimes(2);
  });

  test("late host reads cannot replace the current ready connection", async () => {
    const f = fixture(true);
    const old = deferred<{ id: string }>();
    f.client.getSystemHostConnection.mockReturnValueOnce(old.promise);
    f.controller.setWorkspace("learning");
    await vi.waitFor(() => expect(f.client.getSystemHostConnection).toHaveBeenCalledOnce());
    f.setReady(false); f.controller.runtimeAvailabilityChanged();
    f.setReady(true); f.controller.runtimeAvailabilityChanged();
    await vi.waitFor(() => expect(f.controller.snapshot().hostConnection).toEqual({ id: "host" }));
    old.resolve({ id: "stale-host" });
    await old.promise; await Promise.resolve();
    expect(f.controller.snapshot().hostConnection).toEqual({ id: "host" });
  });

  test.each(["resolve", "reject"])("ignores late detail and mutation %s after readiness changes", async outcome => {
    const f = fixture(true);
    f.controller.setWorkspace("learning");
    await vi.waitFor(() => expect(f.controller.snapshot().loadingStatus).toBe(false));
    const detail = deferred<{ batch: { id: string } }>();
    const mutation = deferred<{ status: ReturnType<typeof status> }>();
    f.client.loadPassiveLearningBatch.mockReturnValueOnce(detail.promise);
    f.client.configurePassiveLearning.mockReturnValueOnce(mutation.promise);
    const detailRead = f.controller.selectBatch("batch");
    const save = f.controller.configure({ enabled: false });
    f.setReady(false); f.controller.runtimeAvailabilityChanged();
    f.setReady(true); f.controller.runtimeAvailabilityChanged();
    await vi.waitFor(() => expect(f.controller.snapshot().status).toEqual(status()));
    if (outcome === "resolve") {
      detail.resolve({ batch: { id: "batch" } }); mutation.resolve({ status: status(false) });
    } else {
      detail.reject(new Error("old detail failure")); mutation.reject(new Error("old mutation failure"));
    }
    await Promise.all([detailRead, save]);
    expect(f.controller.snapshot()).toMatchObject({
      selectedBatchId: "", selectedBatch: null, loadingDetail: false, detailError: "",
      status: status(), statusError: "", saving: false,
    });
    expect(f.client.loadPassiveLearning).toHaveBeenCalledTimes(2);
  });

  test("an environment reset synchronizes readiness before the later ready notification", async () => {
    const f = fixture(true);
    f.controller.setWorkspace("learning");
    await vi.waitFor(() => expect(f.controller.snapshot().status).not.toBeNull());
    f.setReady(false); f.setEnvironment("prod"); f.controller.environmentChanged();
    expect(f.controller.snapshot().status).toBeNull();
    f.setReady(true); f.controller.runtimeAvailabilityChanged();
    await vi.waitFor(() => expect(f.client.loadPassiveLearning).toHaveBeenCalledTimes(2));
    expect(f.client.loadPassiveLearning).toHaveBeenLastCalledWith("prod");
  });

  test("the feature forwards readiness and exposes the readiness transition callback", async () => {
    const f = fixture();
    const doc = { visibilityState: "visible", addEventListener: vi.fn() } as unknown as ConstructorParameters<typeof FakeElement>[1];
    doc.createElement = tag => new FakeElement(tag, doc);
    doc.documentElement = doc.createElement("html"); doc.body = doc.createElement("body");
    vi.stubGlobal("document", doc);
    const feature = createPassiveLearningFeature({
      client: f.client, getEnvironmentId: () => "dev", isRuntimeReady: f.isReady,
      learningRoot: doc.createElement("section"), openLearning: vi.fn(),
      openComputerAccess: vi.fn(), showActivityMemories: vi.fn(),
    });
    feature.setWorkspace("home"); await feature.refresh();
    expect(f.client.loadPassiveLearning).not.toHaveBeenCalled();
    f.setReady(true); feature.runtimeAvailabilityChanged();
    await vi.waitFor(() => expect(feature.snapshot().status).not.toBeNull());
    expect(f.client.loadPassiveLearning).toHaveBeenCalledOnce();
  });
});
