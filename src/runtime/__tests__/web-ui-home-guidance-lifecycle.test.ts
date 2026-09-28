import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only component.
import { createHomeGuidance } from "../../web-ui/app/components/home-guidance/home-guidance.js";
// @ts-expect-error Browser-only component.
import { createDailyReviewDialog } from "../../web-ui/app/components/home-guidance/daily-review.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

vi.mock("../../web-ui/app/components/home-guidance/daily-review.js", () => ({
  createDailyReviewDialog: vi.fn(() => {
    let open = false;
    return {
      render: vi.fn(),
      canOpen: () => !open,
      isOpen: () => open,
      open: vi.fn(() => { open = true; }),
      hide: vi.fn(() => { open = false; }),
      dispose: vi.fn(() => { open = false; }),
    };
  }),
}));

const cleanups: Array<() => void> = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function memoryRecord(environment = "dev") {
  return { id: `${environment}-memory`, origin: "passive_observation", content: "Saved preference",
    createdAt: "2026-09-26T10:00:00Z", updatedAt: "2026-09-26T10:00:00Z" };
}

function memoryPage(environment = "dev") {
  return { total: 1, items: [memoryRecord(environment)], status: { enabled: true, available: true } };
}

function guidanceHarness({ ready = true, learning = false, memoryEnabled = true, stored = new Map<string, string>() } = {}) {
  const visibilityListeners = new Set<() => void>();
  let notifyMutation = () => {};
  const observer = { observe: vi.fn(), disconnect: vi.fn() };
  const document = Object.assign({} as ConstructorParameters<typeof FakeElement>[1], {
    hidden: false,
    defaultView: { MutationObserver: class {
      constructor(callback: () => void) { notifyMutation = callback; }
      observe = observer.observe;
      disconnect = observer.disconnect;
    } },
    addEventListener: (_name: string, callback: () => void) => visibilityListeners.add(callback),
    removeEventListener: (_name: string, callback: () => void) => visibilityListeners.delete(callback),
  });
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const home = document.createElement("section");
  document.body.append(home);
  const container = document.createElement("div") as FakeElement & { prepend(node: FakeElement): void };
  container.prepend = (node) => {
    node.remove();
    container.children.unshift(node);
    node.parentElement = container;
  };
  home.append(container);
  const state = { environment: "dev", ready, learning };
  const client = {
    loadLongTermMemoryStatus: vi.fn(async (_environment: string): Promise<{ status: { enabled: boolean; available?: boolean } }> => ({ status: { enabled: memoryEnabled } })),
    getRuntimePlugins: vi.fn(async (_environment: string) => ({ plugins: [] })),
    listLongTermMemories: vi.fn(async (_input: { environmentId: string; signal: AbortSignal }) => ({ ...memoryPage(), total: 0, items: [] as ReturnType<typeof memoryRecord>[] })),
    deleteLongTermMemory: vi.fn(async () => ({ deleted: true })),
  };
  const refreshConnection = vi.fn(async () => {});
  const guidance = createHomeGuidance({
    container, homeRegion: home, client,
    getEnvironmentId: () => state.environment,
    getLearningSnapshot: () => ({ environmentId: state.environment, statusError: "",
      status: { preferences: { enabled: state.learning, processingPaused: true } } }),
    getConnectionState: () => ({ snapshot: { paired: true } }),
    supportsConnection: () => true, refreshConnection, onOpen: vi.fn(),
    isRuntimeReady: () => state.ready,
    storage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) },
  });
  cleanups.push(() => guidance.dispose());
  const dialog = vi.mocked(createDailyReviewDialog).mock.results.at(-1)!.value;
  const decideReview = vi.mocked(createDailyReviewDialog).mock.calls.at(-1)![0].onDecision;
  function showHome(visible: boolean) {
    home.hidden = !visible;
    if (visible) home.removeAttribute("hidden");
    else home.setAttribute("hidden", "");
    notifyMutation();
  }
  function showDocument(visible: boolean) {
    document.hidden = !visible;
    for (const listener of visibilityListeners) listener();
  }
  const dismissReview = () => {
    dialog.hide();
    vi.mocked(createDailyReviewDialog).mock.calls.at(-1)![0].onDismiss();
  };
  return { state, client, guidance, dialog, container, showHome, showDocument, refreshConnection, observer, dismissReview, decideReview, stored };
}

test.each(["keep", "delete"])("hides the Home review entry after the final %s decision", async (action) => {
  const h = guidanceHarness({ ready: false, learning: true });
  h.client.listLongTermMemories.mockResolvedValue(memoryPage());
  h.state.ready = true;
  h.guidance.render();
  await settle();
  expect(h.dialog.isOpen()).toBe(true);
  await h.decideReview(action);
  expect(h.dialog.render.mock.calls.at(-1)![0].remaining).toBe(0);
  h.dismissReview();
  expect(h.container.querySelector(".home-memory-review")!.hidden).toBe(true);
  h.showHome(false);
  h.showHome(true);
  await settle();
  expect(h.container.querySelector(".home-memory-review")!.hidden).toBe(true);
});

test("reads suggestions once per Home entry without render or visibility loops", async () => {
  const h = guidanceHarness();
  await settle();
  for (let i = 0; i < 8; i++) h.guidance.render();
  h.showHome(true);
  h.showDocument(true);
  await settle();
  expect(h.client.loadLongTermMemoryStatus).toHaveBeenCalledExactlyOnceWith("dev");
  expect(h.client.getRuntimePlugins).toHaveBeenCalledExactlyOnceWith("dev");
  expect(h.client.listLongTermMemories).toHaveBeenCalledOnce();
  expect(h.container.querySelector(".home-memory-review")!.hidden).toBe(true);
  expect(h.refreshConnection).toHaveBeenCalledOnce();

  h.showHome(false);
  h.guidance.render();
  await settle();
  expect(h.client.loadLongTermMemoryStatus).toHaveBeenCalledTimes(1);
  h.showHome(true);
  await settle();
  expect(h.client.loadLongTermMemoryStatus).toHaveBeenCalledTimes(2);
  expect(h.client.getRuntimePlugins).toHaveBeenCalledTimes(2);
  expect(h.refreshConnection).toHaveBeenCalledTimes(2);
  expect(h.client.listLongTermMemories).toHaveBeenCalledTimes(2);
});

test("waits for readiness and reads once when the ready transition requests a render", async () => {
  const h = guidanceHarness({ ready: false, memoryEnabled: false });
  h.guidance.render();
  await settle();
  expect(h.client.loadLongTermMemoryStatus).not.toHaveBeenCalled();
  h.state.ready = true;
  h.guidance.render();
  h.guidance.render();
  await settle();
  expect(h.client.loadLongTermMemoryStatus).toHaveBeenCalledOnce();
  expect(h.container.querySelector(".home-guidance")!.hidden).toBe(false);
});

test("ignores late suggestion responses from the previous environment", async () => {
  const h = guidanceHarness({ ready: false });
  const oldRead = deferred<{ status: { enabled: boolean; available: boolean } }>();
  h.client.loadLongTermMemoryStatus.mockReturnValueOnce(oldRead.promise);
  h.state.ready = true;
  h.guidance.render();
  h.state.environment = "prod";
  h.client.loadLongTermMemoryStatus.mockResolvedValueOnce({ status: { enabled: true, available: true } });
  h.guidance.render();
  await settle();
  const suggestion = h.container.querySelector(".home-guidance")!;
  expect(suggestion.hidden).toBe(true);
  oldRead.resolve({ status: { enabled: false, available: true } });
  await settle();
  expect(suggestion.hidden).toBe(true);
  expect(h.client.loadLongTermMemoryStatus.mock.calls.map(([environment]) => environment)).toEqual(["dev", "prod"]);
  expect(h.client.getRuntimePlugins).toHaveBeenCalledTimes(2);
});

test("aborts an in-flight review on leaving Home and never opens its late result", async () => {
  const h = guidanceHarness({ ready: false, learning: true });
  const pending = deferred<ReturnType<typeof memoryPage>>();
  h.client.listLongTermMemories.mockReturnValueOnce(pending.promise);
  h.state.ready = true;
  h.guidance.render();
  const signal = h.client.listLongTermMemories.mock.calls[0]![0].signal;
  h.showHome(false);
  expect(signal.aborted).toBe(true);
  pending.resolve(memoryPage());
  await settle();
  expect(h.client.listLongTermMemories).toHaveBeenCalledTimes(1);
  expect(h.dialog.open).not.toHaveBeenCalled();
  expect(h.dialog.isOpen()).toBe(false);
});

test("drops a previous environment review while accepting the current environment", async () => {
  const h = guidanceHarness({ ready: false, learning: true });
  const oldReview = deferred<ReturnType<typeof memoryPage>>();
  h.client.listLongTermMemories.mockReturnValueOnce(oldReview.promise).mockResolvedValue(memoryPage("prod"));
  h.state.ready = true;
  h.guidance.render();
  const oldSignal = h.client.listLongTermMemories.mock.calls[0]![0].signal;
  h.state.environment = "prod";
  h.guidance.render();
  await settle();
  expect(oldSignal.aborted).toBe(true);
  expect(h.dialog.open).toHaveBeenCalledOnce();
  oldReview.resolve(memoryPage("dev"));
  await settle();
  expect(h.dialog.render.mock.calls.at(-1)![0].items[0].id).toBe("prod-memory");
  expect(h.dialog.open).toHaveBeenCalledOnce();
  expect(h.client.listLongTermMemories.mock.calls.map(([input]) => input.environmentId)).toEqual(["dev", "prod", "prod"]);
});

test("closes a shown review on browser hide and does not offer it again that day", async () => {
  const h = guidanceHarness({ ready: false, learning: true });
  h.client.listLongTermMemories.mockResolvedValue(memoryPage());
  h.state.ready = true;
  h.guidance.render();
  await settle();
  expect(h.dialog.isOpen()).toBe(true);
  for (let i = 0; i < 8; i++) h.guidance.render();
  expect(h.client.listLongTermMemories).toHaveBeenCalledTimes(2);
  h.showDocument(false);
  expect(h.dialog.isOpen()).toBe(false);
  h.showDocument(true);
  await settle();
  expect(h.dialog.open).toHaveBeenCalledOnce();
  expect(h.client.listLongTermMemories).toHaveBeenCalledTimes(4);
});

test("Not now leaves a Home entry that resumes the same review without another read", async () => {
  const h = guidanceHarness({ ready: false, learning: true });
  h.client.listLongTermMemories.mockResolvedValue(memoryPage());
  h.state.ready = true;
  h.guidance.render();
  await settle();
  expect(h.dialog.isOpen()).toBe(true);
  h.dismissReview();
  const entry = h.container.querySelector(".home-memory-review")!;
  expect(entry.hidden).toBe(false);
  entry.querySelector("[data-review-open]")!.dispatch("click");
  await settle();
  expect(h.dialog.open).toHaveBeenCalledTimes(2);
  expect(h.client.listLongTermMemories).toHaveBeenCalledTimes(2);
  expect(entry.hidden).toBe(true);
});

test("can return after leaving Home without a second automatic offer", async () => {
  const h = guidanceHarness({ ready: false, learning: true });
  h.client.listLongTermMemories.mockResolvedValue(memoryPage());
  h.state.ready = true;
  h.guidance.render();
  await settle();
  h.dismissReview();
  h.showHome(false);
  h.showHome(true);
  await settle();
  expect(h.dialog.open).toHaveBeenCalledOnce();
  h.container.querySelector("[data-review-open]")!.dispatch("click");
  await settle();
  expect(h.dialog.open).toHaveBeenCalledTimes(2);
  expect(h.dialog.render.mock.calls.at(-1)![0].items[0].id).toBe("dev-memory");
});

test("manual review stays available with pending memories and ABot Spark paused", async () => {
  const h = guidanceHarness({ ready: false });
  h.client.loadLongTermMemoryStatus.mockResolvedValue({ status: { enabled: true } });
  h.client.listLongTermMemories.mockResolvedValue(memoryPage());
  h.state.ready = true;
  h.guidance.render();
  await settle();
  expect(h.client.listLongTermMemories).toHaveBeenCalledTimes(2);
  expect(h.dialog.open).not.toHaveBeenCalled();
  expect(h.container.querySelector(".home-memory-review")!.hidden).toBe(false);
  h.container.querySelector("[data-review-open]")!.dispatch("click");
  await settle();
  expect(h.dialog.isOpen()).toBe(true);
});

test("a preview finishing after Home is hidden cannot expose the review entry", async () => {
  const h = guidanceHarness({ ready: false });
  h.client.loadLongTermMemoryStatus.mockResolvedValue({ status: { enabled: true, available: true } });
  const pending = deferred<ReturnType<typeof memoryPage>>();
  h.client.listLongTermMemories.mockReturnValueOnce(pending.promise);
  h.state.ready = true;
  h.guidance.render();
  await settle();
  expect(h.container.querySelector(".home-memory-review")!.hidden).toBe(true);
  h.showHome(false);
  pending.resolve(memoryPage());
  await settle();
  expect(h.dialog.open).not.toHaveBeenCalled();
  expect(h.container.querySelector(".home-memory-review")!.hidden).toBe(true);
});

test("completed receipts survive reload and new memories restore the entry without another daily popup", async () => {
  const h = guidanceHarness({ ready: false, learning: true });
  h.client.listLongTermMemories.mockResolvedValue(memoryPage());
  h.state.ready = true;
  h.guidance.render();
  await settle();
  await h.decideReview("keep");
  h.dismissReview();
  h.showHome(false);

  const reloaded = guidanceHarness({ ready: false, learning: true, stored: h.stored });
  reloaded.client.listLongTermMemories.mockResolvedValue(memoryPage());
  reloaded.state.ready = true;
  reloaded.guidance.render();
  await settle();
  expect(reloaded.container.querySelector(".home-memory-review")!.hidden).toBe(true);
  expect(reloaded.dialog.open).not.toHaveBeenCalled();

  const newMemory = { ...memoryRecord(), id: "new-memory" };
  reloaded.client.listLongTermMemories.mockResolvedValue({ ...memoryPage(), total: 2, items: [memoryRecord(), newMemory] });
  reloaded.showHome(false);
  reloaded.showHome(true);
  await settle();
  expect(reloaded.container.querySelector(".home-memory-review")!.hidden).toBe(false);
  expect(reloaded.dialog.render.mock.calls.at(-1)![0].items).toEqual([newMemory]);
  expect(reloaded.dialog.open).not.toHaveBeenCalled();
});

test.each([
  { enabled: false },
  { enabled: true, available: false },
])("explicit memory unavailability hides review despite active Co-worker: %j", async (status) => {
  const h = guidanceHarness({ ready: false });
  h.client.loadLongTermMemoryStatus.mockResolvedValue({ status });
  h.state.ready = true;
  h.guidance.render();
  await settle();
  h.state.learning = true;
  h.guidance.render();
  const entry = h.container.querySelector(".home-memory-review")!;
  expect(entry.hidden).toBe(true);
  entry.querySelector("[data-review-open]")!.dispatch("click");
  await settle();
  expect(h.client.listLongTermMemories).not.toHaveBeenCalled();
  expect(h.dialog.open).not.toHaveBeenCalled();
});

test("late disabled-memory status cancels a review started while status was unknown", async () => {
  const h = guidanceHarness({ ready: false, learning: true });
  const status = deferred<{ status: { enabled: boolean } }>();
  const page = deferred<ReturnType<typeof memoryPage>>();
  h.client.loadLongTermMemoryStatus.mockReturnValueOnce(status.promise);
  h.client.listLongTermMemories.mockReturnValueOnce(page.promise);
  h.state.ready = true;
  h.guidance.render();
  const signal = h.client.listLongTermMemories.mock.calls[0]![0].signal;
  status.resolve({ status: { enabled: false } });
  await settle();
  expect(signal.aborted).toBe(true);
  page.resolve(memoryPage());
  await settle();
  expect(h.container.querySelector(".home-memory-review")!.hidden).toBe(true);
  expect(h.dialog.open).not.toHaveBeenCalled();
});
