import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationRunHistory, revealSelectedAutomationRun } from "../../web-ui/app/components/automations/run-history.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationLiveView } from "../../web-ui/app/components/automations/live-view.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationRunHistoryControls } from "../../web-ui/app/components/automations/run-history-controls.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function historyFixture() {
  const document = { activeElement: null } as ConstructorParameters<typeof FakeElement>[1];
  const root = new FakeElement("section", document);
  Object.defineProperty(root, "firstChild", { get: () => root.children[0] });
  const html = Object.getOwnPropertyDescriptor(FakeElement.prototype, "innerHTML")!;
  Object.defineProperty(root, "innerHTML", {
    get: () => html.get!.call(root),
    set(value: string) {
      html.set!.call(root, value);
      for (const node of root.querySelectorAll("*")) {
        const matches = node.matches.bind(node);
        Object.assign(node, {
          getAttribute: (name: string) => node.attributes.get(name) ?? null,
          matches: (selector: string) => selector.startsWith("#")
            ? node.attributes.get("id") === selector.slice(1) : matches(selector),
        });
      }
    },
  });
  return { document, root };
}

function runHistory(count = 100) {
  return Array.from({ length: count }, (_, index) => ({
    id: `run-${index}`,
    startedAt: new Date(Date.UTC(2026, 9, 15, 12, count - index)).toISOString(),
    status: index === 0 ? "running" : "succeeded",
  }));
}

describe("Studio run history", () => {
  it("keeps every run selectable and marks only the selected run in a large history", () => {
    const { root } = historyFixture();
    const runs = runHistory(120);
    root.innerHTML = renderAutomationRunHistory({ runs, selectedRunId: "run-90" });
    const buttons = root.querySelectorAll("[data-select-run]");
    expect(buttons.map((button) => button.dataset.selectRun)).toEqual(runs.map((run) => run.id));
    expect(buttons.every((button) => button.type === "button")).toBe(true);
    expect(buttons.every((button) => button.dataset.runId === button.dataset.selectRun)).toBe(true);
    expect(buttons.filter((button) => button.attributes.get("aria-current") === "true")
      .map((button) => button.dataset.selectRun)).toEqual(["run-90"]);
    expect(buttons.every((button) => button.textContent.trim().length > 0)).toBe(true);
  });

  it("escapes run identifiers and status without changing the selected action target", () => {
    const { root } = historyFixture();
    const id = 'run-"><script>unsafe</script>';
    root.innerHTML = renderAutomationRunHistory({
      runs: [{ id, createdAt: "2026-10-15T12:00:00Z", status: '<script>unsafe</script>' }],
      selectedRunId: id,
    });
    expect(root.querySelectorAll("[data-select-run]")).toHaveLength(1);
    expect(root.querySelector("[data-select-run]")?.dataset.selectRun).toBe(id);
    expect(root.querySelector("[data-select-run]")?.attributes.get("aria-current")).toBe("true");
    expect(root.querySelector("script")).toBeNull();
  });

  it("has no selectable run when history is empty or missing", () => {
    const { root } = historyFixture();
    for (const snapshot of [{ runs: [], selectedRunId: "" }, { selectedRunId: "" }]) {
      root.innerHTML = renderAutomationRunHistory(snapshot);
      expect(root.querySelectorAll("[data-select-run]")).toHaveLength(0);
    }
  });

  it("preserves history scroll and focused run when a live refresh prepends another run", () => {
    const { root, document } = historyFixture();
    const live = createAutomationLiveView(root);
    const runs = runHistory();
    live.update("automation/run-90", renderAutomationRunHistory({ runs, selectedRunId: "run-90" }));
    const history = root.querySelector("#automation-run-history-list")!;
    const focusedRun = root.querySelectorAll("[data-select-run]").find((button) => button.dataset.selectRun === "run-60")!;
    history.scrollTop = 540;
    focusedRun.focus();
    const newest = { id: "new-run", status: "running", startedAt: "2026-10-15T16:00:00Z" };
    live.update("automation/run-90", renderAutomationRunHistory({
      runs: [newest, ...runs], selectedRunId: "run-90",
    }));
    expect(root.querySelector("#automation-run-history-list")?.scrollTop).toBe(540);
    expect(document.activeElement?.dataset.selectRun).toBe("run-60");
    expect(document.activeElement).not.toBe(focusedRun);
    expect(root.querySelectorAll("[data-select-run]")[0]?.dataset.selectRun).toBe("new-run");
  });
});

describe("selected Studio run visibility", () => {
  it.each([
    { position: "above", top: 60, bottom: 90, expectedScroll: 360 },
    { position: "below", top: 250, bottom: 280, expectedScroll: 480 },
    { position: "inside", top: 120, bottom: 150, expectedScroll: 400 },
    { position: "at the viewport edges", top: 100, bottom: 200, expectedScroll: 400 },
  ])("reveals a row $position the viewport using only history scrolling", ({ top, bottom, expectedScroll }) => {
    const { root } = historyFixture();
    root.innerHTML = renderAutomationRunHistory({ runs: runHistory(5), selectedRunId: "run-3" });
    const history = root.querySelector("#automation-run-history-list")!;
    const selected = root.querySelectorAll("[data-select-run]").find((button) => button.dataset.selectRun === "run-3")!;
    const pageScroll = vi.fn();
    const rect = (start: number, end: number) => ({
      top: start, bottom: end, left: 0, right: 300, x: 0, y: start, width: 300, height: end - start,
    });
    Object.assign(history, { scrollTop: 400, clientHeight: 100, clientTop: 0,
      getBoundingClientRect: () => rect(100, 200), scrollIntoView: pageScroll });
    Object.assign(selected, { getBoundingClientRect: () => rect(top, bottom), scrollIntoView: pageScroll });
    Object.assign(root, { scrollTop: 1000, scrollIntoView: pageScroll });
    revealSelectedAutomationRun(root);
    expect(history.scrollTop).toBe(expectedScroll);
    expect(root.scrollTop).toBe(1000);
    expect(pageScroll).not.toHaveBeenCalled();
    expect(selected.focus).not.toHaveBeenCalled();
  });

  it("restores focus to the selected run after navigation without moving the page", () => {
    const { root, document } = historyFixture();
    const live = createAutomationLiveView(root);
    const runs = runHistory(5);
    live.update("automation/run-1", renderAutomationRunHistory({ runs, selectedRunId: "run-1" }));
    root.querySelectorAll("[data-select-run]").find((button) => button.dataset.selectRun === "run-3")!.focus();
    live.update("automation/run-3", renderAutomationRunHistory({ runs, selectedRunId: "run-3" }));
    const history = root.querySelector("#automation-run-history-list")!;
    const selected = root.querySelectorAll("[data-select-run]").find((button) => button.dataset.selectRun === "run-3")!;
    const pageScroll = vi.fn();
    Object.assign(history, { scrollTop: 0, clientHeight: 100, clientTop: 0,
      getBoundingClientRect: () => ({ top: 100, bottom: 200 }), scrollIntoView: pageScroll });
    Object.assign(selected, {
      getBoundingClientRect: () => ({ top: 250, bottom: 280 }), scrollIntoView: pageScroll });
    Object.assign(root, { scrollTop: 1000, scrollIntoView: pageScroll });
    revealSelectedAutomationRun(root, { focus: true });
    expect(document.activeElement).toBe(selected);
    expect(selected.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(history.scrollTop).toBe(80);
    expect(root.scrollTop).toBe(1000);
    expect(pageScroll).not.toHaveBeenCalled();
  });

  it("leaves the current viewport alone when no selected row is available", () => {
    const { root } = historyFixture();
    root.innerHTML = renderAutomationRunHistory({ runs: runHistory(3), selectedRunId: "missing" });
    const history = root.querySelector("#automation-run-history-list")!;
    history.scrollTop = 220;
    expect(() => revealSelectedAutomationRun(root)).not.toThrow();
    expect(history.scrollTop).toBe(220);
    root.innerHTML = "";
    expect(() => revealSelectedAutomationRun(root)).not.toThrow();
  });
});


function pagedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    selectedAutomationId: "automation-one", selectedRunId: "run-3", runs: runHistory(50),
    runsNextCursor: "run-49", runsLoading: false, runsError: "", runsFilterError: "",
    runsFilters: { status: "", from: "", to: "" }, ...overrides,
  };
}

function historyControlsFixture(overrides: Record<string, unknown> = {}) {
  const { root, document } = historyFixture();
  const snapshot = pagedSnapshot(overrides);
  const actions = {
    loadMoreRuns: vi.fn(async () => true),
    setRunFilters: vi.fn(async (_filters: Record<string, string>) => true),
    resetRunHistory: vi.fn(async () => true),
    retryRunHistory: vi.fn(async () => true),
  };
  root.innerHTML = renderAutomationRunHistory(snapshot);
  const controls = createAutomationRunHistoryControls({ root, actions });
  controls.sync(snapshot);
  const list = root.querySelector("#automation-run-history-list")!;
  Object.assign(list, { clientHeight: 240, scrollHeight: 1000, scrollTop: 0 });
  return { root, document, snapshot, actions, controls, list };
}

describe("Studio paged history controls", () => {
  it("keeps filter controls available when their result is empty and exposes page errors", () => {
    const { root } = historyFixture();
    root.innerHTML = renderAutomationRunHistory(pagedSnapshot({
      runs: [], runsNextCursor: "", runsFilters: { status: "failed", from: "", to: "" },
      runsFilterError: "The selected date range is invalid.",
    }));
    expect(root.querySelector("[data-run-history-filters]")).not.toBeNull();
    expect(root.querySelector('[name="status"]')).not.toBeNull();
    expect(root.querySelector('[name="from"]')?.type).toBe("date");
    expect(root.querySelector('[name="to"]')?.type).toBe("date");
    expect(root.querySelectorAll("[data-select-run]")).toHaveLength(0);
    expect(root.textContent).toContain("The selected date range is invalid.");
    root.innerHTML = renderAutomationRunHistory(pagedSnapshot({ runsError: "History could not be loaded." }));
    expect(root.textContent).toContain("History could not be loaded.");
    expect(root.querySelector("[data-load-more-runs]")?.disabled).toBe(false);
  });

  it("does not request pages while rendering or syncing a list already at its bottom", () => {
    const { controls, snapshot, list, actions } = historyControlsFixture();
    list.scrollTop = 760;
    controls.sync(snapshot);
    controls.sync({ ...snapshot, runs: [...snapshot.runs] });
    expect(actions.loadMoreRuns).not.toHaveBeenCalled();
  });

  it("loads only near the bottom and suppresses repeated scrolls while the request is pending", async () => {
    const { list, actions } = historyControlsFixture();
    let finish!: (value: boolean) => void;
    actions.loadMoreRuns.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    list.scrollTop = 100;
    list.dispatch("scroll");
    expect(actions.loadMoreRuns).not.toHaveBeenCalled();
    list.scrollTop = 700;
    list.dispatch("scroll");
    list.dispatch("scroll");
    expect(actions.loadMoreRuns).toHaveBeenCalledTimes(1);
    finish(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.loadMoreRuns).toHaveBeenCalledTimes(1);
  });

  it("isolates pending scroll requests across automation changes", async () => {
    const { root, controls, snapshot, list, actions } = historyControlsFixture();
    let finishOld!: (value: boolean) => void;
    let finishNew!: (value: boolean) => void;
    actions.loadMoreRuns
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishNew = resolve; }));
    list.scrollTop = 760;
    list.dispatch("scroll");
    expect(actions.loadMoreRuns).toHaveBeenCalledTimes(1);

    const nextScope = { ...snapshot, selectedAutomationId: "another-automation" };
    root.innerHTML = renderAutomationRunHistory(nextScope);
    controls.sync(nextScope);
    const nextList = root.querySelector("#automation-run-history-list")!;
    Object.assign(nextList, { clientHeight: 240, scrollHeight: 1000, scrollTop: 760 });
    nextList.dispatch("scroll");
    expect(actions.loadMoreRuns).toHaveBeenCalledTimes(2);

    finishOld(true);
    await Promise.resolve();
    await Promise.resolve();
    nextList.dispatch("scroll");
    expect(actions.loadMoreRuns).toHaveBeenCalledTimes(2);

    finishNew(true);
    await Promise.resolve();
    await Promise.resolve();
    nextList.dispatch("scroll");
    expect(actions.loadMoreRuns).toHaveBeenCalledTimes(3);
  });


  it.each([
    { name: "loading page", override: { runsLoading: true } },
    { name: "failed page", override: { runsError: "Unable to fetch the next page." } },
    { name: "exhausted page", override: { runsNextCursor: "" } },
  ])("does not auto-load a $name", ({ override }) => {
    const { list, actions } = historyControlsFixture(override);
    list.scrollTop = 760;
    list.dispatch("scroll");
    expect(actions.loadMoreRuns).not.toHaveBeenCalled();
  });

  it("ignores hidden, unrelated and detached scroll targets", () => {
    const { root, list, snapshot, controls, actions } = historyControlsFixture();
    Object.assign(list, { clientHeight: 0, scrollTop: 1000 });
    list.dispatch("scroll");
    expect(actions.loadMoreRuns).not.toHaveBeenCalled();
    root.dispatch("scroll");
    expect(actions.loadMoreRuns).not.toHaveBeenCalled();
    root.innerHTML = renderAutomationRunHistory(snapshot);
    controls.sync(snapshot);
    Object.assign(list, { clientHeight: 240, scrollTop: 760 });
    for (const listener of root.listeners.get("scroll") || []) listener({ target: list });
    expect(actions.loadMoreRuns).not.toHaveBeenCalled();
  });

  it("offers an explicit retry after a page error", () => {
    const { root, actions } = historyControlsFixture({ runsError: "Request failed." });
    root.querySelector("[data-load-more-runs]")!.dispatch("click");
    expect(actions.retryRunHistory).toHaveBeenCalledTimes(1);
    expect(actions.loadMoreRuns).not.toHaveBeenCalled();
  });

  it("submits the chosen filters and returns to the latest history using separate actions", async () => {
    const { root, actions, controls, snapshot, list } = historyControlsFixture();
    const filters = { status: "failed", from: "2026-10-01", to: "2026-10-15" };
    for (const [name, value] of Object.entries(filters)) root.querySelector(`[name="${name}"]`)!.value = value;
    const submission = root.querySelector("[data-run-history-filters]")!.dispatch("submit");
    expect(submission.preventDefault).toHaveBeenCalled();
    expect(actions.setRunFilters).toHaveBeenCalledWith(filters);
    expect(actions.resetRunHistory).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    list.scrollTop = 700;
    controls.sync({ ...snapshot, runsFilters: filters });
    expect(list.scrollTop).toBe(0);
    root.querySelector("[data-reset-run-history]")!.dispatch("click");
    expect(actions.resetRunHistory).toHaveBeenCalledTimes(1);
  });

  it("retains a partially entered filter through an unrelated live run refresh", () => {
    const { root, controls, snapshot } = historyControlsFixture();
    const status = root.querySelector('[name="status"]')!;
    const from = root.querySelector('[name="from"]')!;
    status.value = "failed";
    status.dispatch("change");
    from.value = "2026-10-03";
    from.dispatch("input");
    root.innerHTML = renderAutomationRunHistory({ ...snapshot, runs: runHistory(51) });
    controls.sync({ ...snapshot, runs: runHistory(51) });
    expect(root.querySelector('[name="status"]')?.value).toBe("failed");
    expect(root.querySelector('[name="from"]')?.value).toBe("2026-10-03");
    const nextAutomation = { ...snapshot, selectedAutomationId: "another-automation" };
    root.innerHTML = renderAutomationRunHistory(nextAutomation);
    controls.sync(nextAutomation);
    expect(root.querySelector('[name="status"]')?.value).toBe("");
    expect(root.querySelector('[name="from"]')?.value).toBe("");
  });

  it("clears an unapplied filter draft when returning to the latest unfiltered history", () => {
    const { root, controls, snapshot, list } = historyControlsFixture();
    const status = root.querySelector('[name="status"]')!;
    status.value = "failed";
    status.dispatch("change");
    list.scrollTop = 700;
    root.querySelector("[data-reset-run-history]")!.dispatch("click");
    root.innerHTML = renderAutomationRunHistory(snapshot);
    controls.sync(snapshot);
    expect(root.querySelector('[name="status"]')?.value).toBe("");
    expect(root.querySelector("#automation-run-history-list")?.scrollTop).toBe(0);
  });


  it("keeps the viewport and focused run when an older page is appended", () => {
    const { root, document } = historyFixture();
    const live = createAutomationLiveView(root);
    const first = pagedSnapshot();
    live.update("automation/run-3", renderAutomationRunHistory(first));
    root.querySelector("#automation-run-history-list")!.scrollTop = 540;
    root.querySelectorAll("[data-select-run]").find((button) => button.dataset.selectRun === "run-30")!.focus();
    const older = runHistory(50).map((run, index) => ({ ...run, id: `run-${index + 50}` }));
    live.update("automation/run-3", renderAutomationRunHistory({
      ...first, runs: [...first.runs, ...older], runsNextCursor: "run-99",
    }));
    expect(root.querySelector("#automation-run-history-list")?.scrollTop).toBe(540);
    expect(document.activeElement?.dataset.selectRun).toBe("run-30");
    expect(root.querySelectorAll("[data-select-run]")).toHaveLength(100);
  });
});
