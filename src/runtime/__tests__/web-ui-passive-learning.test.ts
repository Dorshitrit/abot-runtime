import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPassiveLearningController } from "../../web-ui/app/controllers/passive-learning-controller.js";
// @ts-expect-error Browser-only component has no declaration surface.
import { createPassiveLearningHome } from "../../web-ui/app/components/passive-learning/home.js";
// @ts-expect-error Browser-only component has no declaration surface.
import { createPassiveLearningMemory } from "../../web-ui/app/components/passive-learning/memory.js";
// @ts-expect-error Browser-only presentation has no declaration surface.
import { learningCoveragePresentation, learningIntroText, learningStateLabel } from "../../web-ui/app/components/passive-learning/presentation.js";
// @ts-expect-error Browser-only workspace view has no declaration surface.
import { navigateLearningTabs } from "../../web-ui/app/components/passive-learning/workspace-view.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const readyStatus = (enabled = true) => ({
  preferences: {
    enabled,
    activityPermissions: { collection: true, learning: true, proactive: false },
    modelProfileId: "cloud",
    excludedApplications: [],
    analysisIntervalMinutes: 5,
    analysisWindow: null,
    maxConcurrentBatches: 2,
  },
  state: enabled ? "collecting" : "off",
  deviceId: "paired-desktop",
  pendingObservations: 0,
  processing: false,
  activeBatches: 0,
  effectiveConcurrency: 2,
  droppedObservations: 0,
  recentMemories: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function controllerHarness() {
  let environment = "dev";
  const timers = new Map<number, () => void>();
  let nextTimerId = 0;
  const client = {
    getSystemHostConnection: vi.fn(async () => ({ connected: true })),
    loadPassiveLearning: vi.fn(async () => ({ ok: true, status: readyStatus() })),
    listPassiveLearningBatches: vi.fn(async () => ({ ok: true, items: [] })),
    listModels: vi.fn(async () => ({ profiles: [{ id: "cloud", providerId: "openai" }] })),
    loadPassiveLearningBatch: vi.fn(async (id: string) => ({ batch: { id, observations: [] } })),
    configurePassiveLearning: vi.fn(async () => ({ ok: true, status: readyStatus() })),
  };
  const controller = createPassiveLearningController({
    client,
    getEnvironmentId: () => environment,
    render: vi.fn(),
    isVisible: () => true,
    setTimer: (callback: () => void) => {
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id: number) => { timers.delete(id); },
  });
  return {
    client,
    controller,
    setEnvironment: (value: string) => { environment = value; },
    flushTimer: () => {
      const [id, callback] = timers.entries().next().value || [];
      if (id) timers.delete(id);
      callback?.();
    },
    pendingTimers: () => timers.size,
  };
}

describe("passive learning Web UI transport", () => {
  test("scopes reads and setup download to the selected environment and learning purpose", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: "/web-api", backend: "runtime" }),
      getEnvironmentId: () => "dev one",
      fetchImpl,
      origin: "http://localhost:5177",
    });
    await client.loadPassiveLearning();
    await client.listPassiveLearningBatches();
    await client.loadPassiveLearningBatch("batch/1");
    await client.configurePassiveLearning({ enabled: true, modelProfileId: "cloud" });
    await client.downloadSystemHostSetup("linux", { purpose: "learning" });
    await client.listLongTermMemories({ origin: "passive_observation" });
    expect(fetchImpl.mock.calls.slice(0, 3).map(([url]) => url)).toEqual([
      "/web-api/runtime/learning?environment=dev%20one",
      "/web-api/runtime/learning/batches?environment=dev%20one",
      "/web-api/runtime/learning/batches/batch%2F1?environment=dev%20one",
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toEqual({ environment: "dev one", enabled: true, modelProfileId: "cloud" });
    expect(JSON.parse(String(fetchImpl.mock.calls[4]?.[1]?.body))).toEqual({ platform: "linux", purpose: "learning" });
    expect(fetchImpl.mock.calls[5]?.[0]).toBe("/web-api/runtime/memory/records?environment=dev+one&limit=20&offset=0&origin=passive_observation");
  });
});

describe("passive learning visible reads", () => {
  test("reloads model choices when refreshing or returning to Learning", async () => {
    const h = controllerHarness();
    h.controller.setWorkspace("learning");
    await vi.waitFor(() => expect(h.controller.snapshot().models).toHaveLength(1));
    h.client.listModels.mockResolvedValue({ profiles: [{ id: "new", providerId: "openai" }] });
    await h.controller.refresh();
    expect(h.controller.snapshot().models[0].id).toBe("new");
    h.controller.setWorkspace("config");
    h.client.listModels.mockResolvedValue({ profiles: [] });
    h.controller.setWorkspace("learning");
    await vi.waitFor(() => expect(h.controller.snapshot().models).toEqual([]));
  });

  test("drops removed batch details and ignores a late detail response", async () => {
    const h = controllerHarness();
    h.controller.setWorkspace("learning");
    await vi.waitFor(() => expect(h.controller.snapshot().loadingBatches).toBe(false));
    await h.controller.selectBatch("expired");
    expect(h.controller.snapshot().selectedBatch.id).toBe("expired");
    await h.controller.refresh();
    expect(h.controller.snapshot()).toMatchObject({ selectedBatchId: "", selectedBatch: null });
    const late = deferred<{ batch: { id: string; observations: never[] } }>();
    h.client.loadPassiveLearningBatch.mockImplementationOnce(() => late.promise);
    const read = h.controller.selectBatch("expired");
    await h.controller.refresh();
    late.resolve({ batch: { id: "expired", observations: [] } });
    await read;
    expect(h.controller.snapshot()).toMatchObject({ selectedBatchId: "", selectedBatch: null, loadingDetail: false });
  });
  test("reads Home status and loads batches/models only in Learning", async () => {
    const harness = controllerHarness();
    harness.controller.setWorkspace("home");
    await vi.waitFor(() => expect(harness.client.loadPassiveLearning).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.controller.snapshot().status).not.toBeNull());
    expect(harness.client.listPassiveLearningBatches).not.toHaveBeenCalled();
    expect(harness.client.listModels).not.toHaveBeenCalled();
    expect(harness.client.getSystemHostConnection).toHaveBeenCalledOnce();
    harness.controller.setWorkspace("config");
    harness.controller.handleRealtime({ type: "learning.changed", environmentId: "dev" });
    expect(harness.pendingTimers()).toBe(0);
    expect(harness.client.listPassiveLearningBatches).not.toHaveBeenCalled();
    harness.controller.setWorkspace("learning");
    await vi.waitFor(() => expect(harness.client.listPassiveLearningBatches).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.controller.snapshot().loadingBatches).toBe(false));
    expect(harness.client.listModels).toHaveBeenCalledTimes(1);
    expect(harness.client.getSystemHostConnection).toHaveBeenCalledTimes(2);
    harness.controller.handleRealtime({ type: "learning.changed", environmentId: "dev" });
    harness.controller.handleRealtime({ type: "learning.changed", environmentId: "dev" });
    expect(harness.pendingTimers()).toBe(1);
    harness.flushTimer();
    await vi.waitFor(() => expect(harness.client.listPassiveLearningBatches).toHaveBeenCalledTimes(2));
    expect(harness.client.listModels).toHaveBeenCalledTimes(1);
    expect(harness.pendingTimers()).toBe(0);
    expect(harness.client.getSystemHostConnection).toHaveBeenCalledTimes(2);
  });

  test("discards late responses from the previous environment and ignores foreign events", async () => {
    const harness = controllerHarness();
    const late = deferred<{ ok: true; status: ReturnType<typeof readyStatus> }>();
    harness.client.loadPassiveLearning.mockImplementationOnce(() => late.promise);
    harness.controller.setWorkspace("home");
    expect(harness.client.loadPassiveLearning).toHaveBeenCalledWith("dev");
    harness.setEnvironment("staging");
    harness.controller.environmentChanged();
    await vi.waitFor(() => expect(harness.controller.snapshot().status).not.toBeNull());
    expect(harness.controller.snapshot().environmentId).toBe("staging");
    late.resolve({ ok: true, status: readyStatus(false) });
    await Promise.resolve();
    expect(harness.controller.snapshot().status?.preferences.enabled).toBe(true);
    const reads = harness.client.loadPassiveLearning.mock.calls.length;
    harness.controller.handleRealtime({ type: "learning.changed", environmentId: "dev" });
    expect(harness.pendingTimers()).toBe(0);
    expect(harness.client.loadPassiveLearning).toHaveBeenCalledTimes(reads);
  });
});

describe("passive learning coverage presentation", () => {
  test.each([
    "uia_application_coverage",
    "ax_application_coverage",
    "atspi_application_coverage",
  ])("presents %s as collecting visible app content", (reason) => {
    const status = { ...readyStatus(), state: "partial", reason };
    expect(learningStateLabel(status)).toBe("Collecting");
    expect(learningCoveragePresentation(status)).toEqual(expect.objectContaining({
      label: "Visible app content",
      detail: expect.stringMatching(/content.*apps/i),
    }));
    expect(learningIntroText(status)).toMatch(/visible computer activity/i);
  });

  test("distinguishes an accessibility read failure from ordinary app coverage", () => {
    const status = { ...readyStatus(), state: "partial", reason: "accessibility_read_unavailable" };
    const coverage = learningCoveragePresentation(status);
    expect(learningStateLabel(status)).toBe("Limited access");
    expect(coverage.label).toBe("Some content unreadable");
    expect(coverage.detail).toMatch(/did not expose readable content/i);
    expect(coverage).not.toEqual(learningCoveragePresentation({
      ...status,
      reason: "uia_application_coverage",
    }));
  });

  test("explains that collection is off while earlier memories remain", () => {
    const status = { ...readyStatus(false), recentMemories: [{ id: "saved" }] };
    expect(learningStateLabel(status)).toBe("Collection stopped");
    expect(learningCoveragePresentation(status).label).toBe("Not collecting");
    expect(learningIntroText(status)).toMatch(/saved insights.*(?:kept|saved|review)/i);
    expect(learningIntroText(status)).not.toMatch(/available in conversations/i);
  });
});

describe("passive learning Home card", () => {
  test("keeps the setup entry visible and opens Learning without showing collected knowledge or touching composer", () => {
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    const openLearning = vi.fn();
    const home = createPassiveLearningHome({ openLearning });
    home.mount(root as never);
    home.render({ status: readyStatus(false) } as never);
    expect(root.hidden).toBe(false);
    home.render({ status: {
      ...readyStatus(),
      recentMemories: [{ id: "one", content: "<img src=x onerror=alert(1)>", createdAt: "2026-09-23T10:00:00Z" }],
    } } as never);
    expect(root.hidden).toBe(false);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[data-learning-memories]")).toBeNull();
    root.querySelector("[data-learning-open]")?.dispatch("click");
    expect(openLearning).toHaveBeenCalledTimes(1);
  });
});

describe("passive learning agent form", () => {
  test("preserves a frequency draft through status refresh and saves it with model and cloud limit", () => {
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    const snapshot = {
      environmentId: "dev",
      status: readyStatus(),
      models: [{ id: "cloud", label: "Cloud", providerId: "openai" }],
      batches: [],
      selectedBatch: null,
      selectedBatchId: "",
      detailError: "",
      statusError: "",
      modelsError: "",
      batchError: "",
      loadingStatus: false,
      loadingBatches: false,
      loadingDetail: false,
      saving: false,
    };
    const configure = vi.fn();
    const memory = createPassiveLearningMemory({
      actions: { snapshot: () => snapshot, configure, refresh: vi.fn(), selectBatch: vi.fn() },
      showActivityMemories: vi.fn(),
      openComputerAccess: vi.fn(),
    });
    memory.mount(root as never);
    const insights = root.querySelector('[data-learning-panel="insights"]')!;
    const activity = root.querySelector('[data-learning-panel="activity"]')!;
    const settings = root.querySelector('[data-learning-panel="settings"]')!;
    expect(insights.hidden).toBe(false);
    expect(activity.hidden).toBe(true);
    expect(settings.hidden).toBe(true);
    expect(activity.querySelector("[data-learning-device]")).toBeNull();
    expect(settings.querySelector("[data-learning-device]")).not.toBeNull();
    root.querySelector('[data-learning-tab="settings"]')!.dispatch("click");
    expect(settings.hidden).toBe(false);
    expect(root.querySelector('[data-learning-tab="settings"]')?.attributes.get("aria-selected")).toBe("true");
    const interval = root.querySelector("[data-learning-interval]")!;
    interval.value = "30";
    interval.dispatch("input");
    memory.render({ ...snapshot, status: { ...snapshot.status, pendingObservations: 4 } });
    expect(interval.value).toBe("30");
    expect(settings.hidden).toBe(false);
    root.querySelector("[data-learning-settings]")!.dispatch("submit");
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      modelProfileId: "cloud",
      analysisIntervalMinutes: 30,
      maxConcurrentBatches: 2,
      analysisWindow: null,
    }));
    expect(configure.mock.calls[0]?.[0].activityPermissions).toEqual(snapshot.status.preferences.activityPermissions);
    expect(configure.mock.calls[0]?.[0]).not.toHaveProperty("enabled");
  });

  test("switches views without resetting the draft and starts only collection from its saved settings", () => {
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    const snapshot = {
      environmentId: "dev", status: readyStatus(false),
      models: [{ id: "cloud", label: "Cloud", providerId: "openai" }],
      batches: [], selectedBatch: null, selectedBatchId: "",
      detailError: "", statusError: "", modelsError: "", batchError: "",
      loadingStatus: false, loadingBatches: false, loadingDetail: false, saving: false,
    };
    const configure = vi.fn();
    const view = createPassiveLearningMemory({
      actions: { snapshot: () => snapshot, configure, refresh: vi.fn(), selectBatch: vi.fn() },
      showActivityMemories: vi.fn(), openComputerAccess: vi.fn(),
    });
    view.mount(root as never);
    root.querySelector('[data-learning-tab="activity"]')!.dispatch("click");
    expect(root.querySelector('[data-learning-panel="activity"]')?.hidden).toBe(false);
    expect(root.querySelector('[data-learning-panel="insights"]')?.hidden).toBe(true);
    view.render({ ...snapshot, status: { ...snapshot.status, pendingObservations: 2 } });
    expect(root.querySelector('[data-learning-panel="activity"]')?.hidden).toBe(false);

    root.querySelector('[data-learning-tab="settings"]')!.dispatch("click");
    const interval = root.querySelector("[data-learning-interval]")!;
    interval.value = "30";
    interval.dispatch("input");
    root.querySelector("[data-learning-toggle]")!.dispatch("click");
    expect(configure).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    expect(interval.value).toBe("30");
    expect(root.querySelector('[data-learning-panel="settings"]')?.hidden).toBe(false);

    interval.value = "0";
    interval.dispatch("input");
    root.querySelector("[data-learning-toggle]")!.dispatch("click");
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenLastCalledWith({ enabled: true });
    expect(root.querySelector("[data-learning-settings-feedback]")?.textContent).toContain("Unsaved changes");
    expect(root.querySelector('[data-learning-panel="settings"]')?.hidden).toBe(false);

    snapshot.status.preferences.modelProfileId = "";
    view.render(snapshot);
    root.querySelector('[data-learning-tab="insights"]')!.dispatch("click");
    root.querySelector("[data-learning-toggle]")!.dispatch("click");
    expect(root.querySelector('[data-learning-panel="settings"]')?.hidden).toBe(false);
    expect(document.activeElement).toBe(root.querySelector("[data-learning-model]"));
    expect(configure).toHaveBeenCalledTimes(2);
  });

  test("arrow and End keys navigate the four accessible Co-worker views", () => {
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    const snapshot = {
      environmentId: "dev", status: readyStatus(false), models: [], batches: [],
      selectedBatch: null, selectedBatchId: "", detailError: "", statusError: "",
      modelsError: "", batchError: "", loadingStatus: false,
      loadingBatches: false, loadingDetail: false, saving: false,
    };
    createPassiveLearningMemory({
      actions: { snapshot: () => snapshot, configure: vi.fn(), refresh: vi.fn(), selectBatch: vi.fn() },
      showActivityMemories: vi.fn(), openComputerAccess: vi.fn(),
    }).mount(root as never);
    const insights = root.querySelector('[data-learning-tab="insights"]')!;
    const activity = root.querySelector('[data-learning-tab="activity"]')!;
    const preventDefault = vi.fn();
    navigateLearningTabs(root, { target: insights, key: "ArrowRight", preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(activity.attributes.get("aria-selected")).toBe("true");
    expect(root.querySelector('[data-learning-panel="activity"]')?.hidden).toBe(false);
    expect(document.activeElement).toBe(activity);
    navigateLearningTabs(root, { target: activity, key: "End", preventDefault });
    expect(root.querySelector('[data-learning-tab="usage"]')?.attributes.get("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(root.querySelector('[data-learning-tab="usage"]'));
  });

  test("explains an unpaired computer above settings and opens setup only on request", () => {
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    const snapshot = {
      environmentId: "dev",
      status: readyStatus(),
      models: [{ id: "cloud", label: "Cloud", providerId: "openai" }],
      batches: [], selectedBatch: null, selectedBatchId: "",
      detailError: "", statusError: "", modelsError: "", batchError: "",
      loadingStatus: false, loadingBatches: false, loadingDetail: false, saving: false,
    };
    const openComputerAccess = vi.fn();
    const memory = createPassiveLearningMemory({
      actions: { snapshot: () => snapshot, configure: vi.fn(), refresh: vi.fn(), selectBatch: vi.fn() },
      showActivityMemories: vi.fn(), openComputerAccess,
    });
    memory.mount(root as never);
    const attention = root.querySelector("[data-learning-attention]")!;
    const connect = root.querySelector("[data-learning-open-setup]")!;
    const setup = root.querySelector("[data-learning-setup]")!;
    expect(attention.hidden).toBe(true);
    expect(setup.open).toBe(false);

    memory.render({ ...snapshot, status: { ...readyStatus(), state: "failed", reason: "host_not_paired" } });
    expect(root.querySelector("[data-learning-state]")?.textContent).toBe("Setup required");
    expect(attention.hidden).toBe(false);
    expect(root.querySelector("[data-learning-attention-text]")?.textContent).toContain("No computer is paired");
    expect(root.querySelector("[data-learning-coverage]")?.textContent).toBe("Not collecting");
    expect(root.querySelector("[data-learning-reason]")?.textContent).toContain("host_not_paired");
    expect(connect.hidden).toBe(false);
    expect(setup.open).toBe(false);
    connect.dispatch("click");
    expect(setup.open).toBe(false);
    expect(openComputerAccess).toHaveBeenCalledOnce();
    expect(root.innerHTML).not.toContain("data-learning-install");

    memory.render({ ...snapshot, status: { ...readyStatus(), state: "failed", reason: "host_observations_unsupported" } });
    expect(root.querySelector("[data-learning-state]")?.textContent).toBe("Setup required");
    expect(connect.hidden).toBe(false);
    memory.render({ ...snapshot, status: { ...readyStatus(), state: "disconnected", reason: "host_disconnected" } });
    expect(root.querySelector("[data-learning-state]")?.textContent).toBe("Disconnected");
    expect(connect.hidden).toBe(false);

    memory.render({ ...snapshot, status: { ...readyStatus(), state: "failed", reason: "learning_model_profile_unavailable" } });
    expect(root.querySelector("[data-learning-state]")?.textContent).toBe("Failed");
    expect(root.querySelector("[data-learning-attention-text]")?.textContent).toContain("learning model is unavailable");
    expect(connect.hidden).toBe(true);
    memory.render(snapshot);
    expect(attention.hidden).toBe(true);
  });

  test("keeps diagnostics separate from coverage and shows saved memories after collection stops", () => {
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    const snapshot = {
      environmentId: "dev",
      status: { ...readyStatus(), state: "partial", reason: "uia_application_coverage" },
      models: [], batches: [], selectedBatch: null, selectedBatchId: "",
      detailError: "", statusError: "", modelsError: "", batchError: "",
      loadingStatus: false, loadingBatches: false, loadingDetail: false, saving: false,
    };
    const view = createPassiveLearningMemory({
      actions: { snapshot: () => snapshot, configure: vi.fn(), refresh: vi.fn(), selectBatch: vi.fn() },
      showActivityMemories: vi.fn(), openComputerAccess: vi.fn(),
    });
    view.mount(root as never);
    expect(root.querySelector("[data-learning-state]")?.textContent).toBe("Collecting");
    expect(root.querySelector("[data-learning-coverage]")?.textContent).toBe("Visible app content");
    expect(root.querySelector("[data-learning-coverage-detail]")?.textContent).toMatch(/content.*apps/i);
    expect(root.querySelector("[data-learning-coverage]")?.textContent).not.toContain("uia_application_coverage");
    expect(root.querySelector("[data-learning-reason]")?.textContent).toContain("uia_application_coverage");

    view.render({ ...snapshot, status: {
      ...readyStatus(false),
      recentMemories: [{ id: "saved", content: "<img src=x onerror=alert(1)>", createdAt: "2026-09-23T10:00:00Z" }],
    } });
    expect(root.querySelector("[data-learning-state]")?.textContent).toBe("Collection stopped");
    expect(root.querySelector("[data-learning-saved]")?.textContent).toContain("<img src=x");
    expect(root.querySelector("img")).toBeNull();

    view.render({ ...snapshot, status: null, loadingStatus: true });
    expect(root.querySelector("[data-learning-saved]")?.textContent).toMatch(/loading|checking/i);
    expect(root.querySelector("[data-learning-saved]")?.textContent).not.toMatch(/no insights yet/i);
    view.render({ ...snapshot, status: null, statusError: "Request failed" });
    expect(root.querySelector("[data-learning-saved]")?.textContent).toMatch(/unavailable|could not.*load|couldn't.*load/i);
    expect(root.querySelector("[data-learning-saved]")?.textContent).not.toMatch(/no insights yet/i);
  });
});
