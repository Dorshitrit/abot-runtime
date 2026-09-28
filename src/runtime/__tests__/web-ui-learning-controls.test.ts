import { describe, expect, test, vi } from "vitest";
import { DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
// @ts-expect-error Browser-only component has no declaration surface.
import { createPassiveLearningMemory } from "../../web-ui/app/components/passive-learning/memory.js";
// @ts-expect-error Browser-only component has no declaration surface.
import { createPassiveLearningHome } from "../../web-ui/app/components/passive-learning/home.js";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPassiveLearningController } from "../../web-ui/app/controllers/passive-learning-controller.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function learningStatus(enabled = true, processingPaused = false) {
  return {
    preferences: {
      enabled, processingPaused, modelProfileId: "cloud", excludedApplications: [],
      activityPermissions: { collection: true, learning: true, proactive: false },
      analysisIntervalMinutes: 5, analysisWindow: null, maxConcurrentBatches: 1,
    },
    state: enabled ? "collecting" : "off", pendingObservations: 3,
    processing: false, activeBatches: 0, effectiveConcurrency: 1,
    droppedObservations: 0, recentMemories: [], retentionHours: 24,
  };
}

function createRoot() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  return document.createElement("section");
}

function controlsHarness(enabled = true, processingPaused = false) {
  const root = createRoot();
  const snapshot = {
    environmentId: "dev", status: learningStatus(enabled, processingPaused),
    models: [{ id: "cloud", label: "Cloud", providerId: "openai" }],
    batches: [], selectedBatch: null, selectedBatchId: "", detailError: "",
    statusError: "", modelsError: "", batchError: "", loadingStatus: false,
    loadingBatches: false, loadingDetail: false, saving: false,
  };
  const configure = vi.fn();
  const clearPending = vi.fn();
  const confirmDelete = vi.fn(() => true);
  const view = createPassiveLearningMemory({
    actions: { snapshot: () => snapshot, configure, clearPending, refresh: vi.fn(), selectBatch: vi.fn() },
    showActivityMemories: vi.fn(), downloadSetup: vi.fn(), confirmDelete,
  });
  view.mount(root);
  return { root, snapshot, view, configure, clearPending, confirmDelete };
}

describe("independent passive learning controls", () => {
  test("fresh learning opens model setup without enabling processing", () => {
    const h = controlsHarness(false, true);
    Object.assign(h.snapshot.status.preferences, DEFAULT_LEARNING_PREFERENCES, { modelProfileId: undefined });
    h.view.render(h.snapshot);
    const processing = h.root.querySelector("[data-learning-processing-toggle]")!;
    expect(processing.textContent).toBe("Set up learning");
    expect(processing.dataset.actionTone).toBe("setup");
    processing.dispatch("click");
    expect(h.configure).not.toHaveBeenCalled();
    expect(h.root.querySelector('[data-learning-panel="settings"]')?.hidden).toBe(false);
    expect(h.root.ownerDocument.activeElement).toBe(h.root.querySelector("[data-learning-model]"));
  });

  test("stops only collection and preserves the processing preference and pending count", () => {
    const h = controlsHarness();
    h.root.querySelector("[data-learning-toggle]")!.dispatch("click");
    expect(h.configure).toHaveBeenCalledWith({ enabled: false });
    expect(h.clearPending).not.toHaveBeenCalled();
    expect(h.confirmDelete).not.toHaveBeenCalled();
    h.snapshot.status.preferences.enabled = false;
    h.snapshot.status.state = "off";
    h.view.render(h.snapshot);
    expect(h.root.querySelector("[data-learning-state]")?.textContent).toBe("Collection stopped");
    expect(h.root.querySelector("[data-learning-pending]")?.textContent).toBe("3 waiting");
    expect(h.root.querySelector("[data-learning-processing-toggle]")?.disabled).toBe(false);
    expect(h.root.querySelector("[data-learning-processing-status]")?.textContent).toContain("existing schedule");
  });

  test.each([true, false])("pauses and resumes processing independently when collection enabled=%s", (enabled) => {
    const h = controlsHarness(enabled);
    h.root.querySelector("[data-learning-processing-toggle]")!.dispatch("click");
    expect(h.configure).toHaveBeenLastCalledWith({ processingPaused: true });
    h.snapshot.status.preferences.processingPaused = true;
    h.view.render(h.snapshot);
    expect(h.root.querySelector("[data-learning-processing-toggle]")?.textContent).toBe("Start learning");
    expect(h.root.querySelector("[data-learning-pending]")?.textContent).toBe("3 waiting");
    expect(h.root.querySelector("[data-learning-retention]")?.textContent).toContain("24 hours");
    h.root.querySelector("[data-learning-processing-toggle]")!.dispatch("click");
    expect(h.configure).toHaveBeenLastCalledWith({ processingPaused: false });
    expect(h.clearPending).not.toHaveBeenCalled();
    expect(h.confirmDelete).not.toHaveBeenCalled();
  });

  test("starting collection does not implicitly resume paused processing", () => {
    const h = controlsHarness(false, true);
    h.root.querySelector("[data-learning-toggle]")!.dispatch("click");
    expect(h.configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(h.configure.mock.calls[0]?.[0]).not.toHaveProperty("processingPaused");
  });

  test("deleting pending activity requires its own explicit confirmation", () => {
    const h = controlsHarness(false, true);
    h.root.querySelector('[data-learning-tab="activity"]')!.dispatch("click");
    const remove = h.root.querySelector("[data-learning-clear-pending]")!;
    h.confirmDelete.mockReturnValueOnce(false);
    remove.dispatch("click");
    expect(h.clearPending).not.toHaveBeenCalled();
    remove.dispatch("click");
    expect(h.confirmDelete).toHaveBeenCalledTimes(2);
    expect(h.clearPending).toHaveBeenCalledTimes(1);
    expect(h.configure).not.toHaveBeenCalled();
  });

  test("disables deletion for an empty queue and all mutations while a save is pending", () => {
    const h = controlsHarness();
    h.snapshot.status.pendingObservations = 0;
    h.view.render(h.snapshot);
    expect(h.root.querySelector("[data-learning-clear-pending]")?.disabled).toBe(true);
    h.snapshot.saving = true;
    h.view.render(h.snapshot);
    expect(h.root.querySelector("[data-learning-toggle]")?.disabled).toBe(true);
    expect(h.root.querySelector("[data-learning-processing-toggle]")?.disabled).toBe(true);
    expect(h.root.querySelector("[data-learning-clear-pending]")?.disabled).toBe(true);
  });

  test("blocked evidence is deletable but never presented as waiting in Co-worker or Home", () => {
    const h = controlsHarness();
    const status = Object.assign(h.snapshot.status, { pendingObservations: 0, blockedObservations: 23 });
    h.view.render({ ...h.snapshot, status });
    expect(h.root.querySelector("[data-learning-pending]")?.textContent).toBe("0 waiting");
    expect(h.root.querySelector("[data-learning-clear-pending]")?.disabled).toBe(false);
    h.root.querySelector('[data-learning-tab="activity"]')!.dispatch("click");
    h.root.querySelector("[data-learning-clear-pending]")!.dispatch("click");
    expect(h.clearPending).toHaveBeenCalledOnce();
    const root = createRoot();
    const home = createPassiveLearningHome({ openLearning: vi.fn() });
    home.mount(root);
    home.render({ status });
    expect(root.querySelector("[data-agent-processing]")?.textContent).not.toContain("23");
    expect(root.querySelector("[data-agent-processing]")?.textContent).toBe("Waiting for useful activity");
  });

  test("Home retains pending activity and the setup entry after collection stops", () => {
    const root = createRoot();
    const home = createPassiveLearningHome({ openLearning: vi.fn() });
    home.mount(root);
    const status = learningStatus(false, true);
    home.render({ status });
    expect(root.hidden).toBe(false);
    expect(root.querySelector("[data-agent-processing]")?.textContent).toContain("Paused");
    status.pendingObservations = 0;
    home.render({ status });
    expect(root.hidden).toBe(false);
    status.processing = true;
    status.activeBatches = 1;
    home.render({ status });
    expect(root.hidden).toBe(false);
  });

  test.each(["learning_model_profile_unavailable", "learning_memory_unavailable", "learning_storage_unavailable"])(
    "collection stopped still exposes processing failure %s",
    (reason) => {
      const h = controlsHarness(false);
      h.view.render({ ...h.snapshot, status: { ...h.snapshot.status, state: "failed", reason } });
      expect(h.root.querySelector("[data-learning-attention]")?.hidden).toBe(false);
      expect(h.root.querySelector("[data-learning-open-setup]")?.hidden).toBe(true);
      expect(h.root.querySelector("[data-learning-processing-status]")?.textContent).toContain("Processing needs attention");
    },
  );

  test("processing readiness requires a model but not a collecting computer", () => {
    const h = controlsHarness(false);
    h.snapshot.status.preferences.modelProfileId = "";
    h.view.render(h.snapshot);
    expect(h.root.querySelector("[data-learning-processing-status]")?.textContent).toContain("Choose a model");
    h.snapshot.status.preferences.modelProfileId = "cloud";
    h.view.render({ ...h.snapshot, status: { ...h.snapshot.status, state: "disconnected", reason: "host_disconnected" } });
    expect(h.root.querySelector("[data-learning-attention]")?.hidden).toBe(true);
    expect(h.root.querySelector("[data-learning-processing-status]")?.textContent).toContain("existing schedule");
  });
});

describe("pending activity deletion transport", () => {
  test("sends an environment-scoped DELETE separately from configuration", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: "/web-api", backend: "runtime" }),
      getEnvironmentId: () => "dev one", fetchImpl, origin: "http://localhost:5177",
    });
    await client.clearPassiveLearningPending();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/web-api/runtime/learning/pending?environment=dev%20one");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("content-type")).toBe("application/json");
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe("{}");
  });

  test("serializes deletion with saves and discards a response from another environment", async () => {
    let environment = "dev";
    let resolve!: (result: unknown) => void;
    const client = {
      clearPassiveLearningPending: vi.fn(() => new Promise((done) => { resolve = done; })),
      configurePassiveLearning: vi.fn(),
    };
    const controller = createPassiveLearningController({
      client, getEnvironmentId: () => environment, render: vi.fn(), isVisible: () => false,
    });
    const deleting = controller.clearPending();
    expect(controller.snapshot().saving).toBe(true);
    await controller.configure({ enabled: false });
    expect(client.configurePassiveLearning).not.toHaveBeenCalled();
    expect(client.clearPassiveLearningPending).toHaveBeenCalledWith("dev");
    environment = "other";
    controller.environmentChanged();
    resolve({ ok: true, status: learningStatus(false) });
    await deleting;
    expect(controller.snapshot().status).toBeNull();
    expect(controller.snapshot().saving).toBe(false);
  });

  test("renders the canonical post-delete state and reports unconfirmed deletion", async () => {
    const status = { ...learningStatus(false), pendingObservations: 0 };
    const client = { clearPassiveLearningPending: vi.fn(async () => ({ ok: true, status })) };
    const controller = createPassiveLearningController({
      client, getEnvironmentId: () => "dev", render: vi.fn(), isVisible: () => false,
    });
    await controller.clearPending();
    expect(controller.snapshot().status).toEqual(status);
    client.clearPassiveLearningPending.mockRejectedValueOnce(new Error("Access denied"));
    await controller.clearPending();
    expect(controller.snapshot().statusError).toBe("Access denied");
    expect(controller.snapshot().status).toEqual(status);
  });
});
