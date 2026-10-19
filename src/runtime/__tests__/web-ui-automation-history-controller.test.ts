import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";
import { createAutomationRequests } from "../../web-ui/app/services/runtime-web-client/automations.js";

type Page = { runs: { id: string; status: string }[]; nextCursor: string | null };
const page = (ids: string[], nextCursor: string | null = null): Page => ({
  runs: ids.map((id) => ({ id, status: "failed" })), nextCursor,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let environment = "dev";
  let runStatus = "running";
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async () => ({ automations: [{ id: "one" }, { id: "two" }] })),
    getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
    getAutomationDraft: vi.fn(async (automationId: string) => ({ draft: {
      automationId, revision: 1, definition: { title: automationId,
        body: { kind: "sequence", id: "root", children: [] } },
    } })),
    listAutomationRuns: vi.fn(async (_automationId: string, _environmentId: string,
      _query: Record<string, unknown>): Promise<Page> => page(["run-a", "run-b"], "cursor-1")),
    getAutomationRun: vi.fn(async (id: string) => ({ run: { id, automationId: "one", status: runStatus } })),
    getAutomationStepEvidence: vi.fn(async () => ({ evidence: null })),
  };
  const render = vi.fn();
  const controller = createAutomationsController({ client, render,
    getEnvironmentId: () => environment, isVisible: () => true });
  return { client, controller, render,
    setEnvironment: (value: string) => { environment = value; },
    setRunStatus: (value: string) => { runStatus = value; },
  };
}

async function open(f: ReturnType<typeof fixture>) {
  await f.controller.openRoute("one", "run-a");
  f.controller.setWorkspaceActive(true);
}

async function event(f: ReturnType<typeof fixture>) {
  f.controller.handleRealtime({ type: "event", name: "scheduler.changed", environment: "dev" });
  await vi.advanceTimersByTimeAsync(80);
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Studio run history controller", () => {
  test("library background refresh leaves history empty and does not fetch a history page", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.openRoute();
    f.controller.setWorkspaceActive(true);
    await event(f);
    expect(f.controller.snapshot()).toMatchObject({ runs: [], runsNextCursor: null });
    expect(f.client.listAutomationRuns).not.toHaveBeenCalled();
  });

  test("loads 50 summaries, appends each cursor once, and deduplicates overlapping pages", async () => {
    const f = fixture();
    await open(f);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50 });
    const held = deferred<Page>();
    f.client.listAutomationRuns.mockReturnValueOnce(held.promise);
    const pending = f.controller.loadMoreRuns();
    expect(f.controller.loadMoreRuns()).toBe(false);
    expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(2);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50, cursor: "cursor-1" });
    held.resolve(page(["run-b", "run-c"]));
    expect(await pending).toBe(true);
    expect(f.controller.snapshot().runs.map((run: { id: string }) => run.id)).toEqual(["run-a", "run-b", "run-c"]);
    expect(f.controller.snapshot().runsNextCursor).toBeNull();
    expect(f.controller.loadMoreRuns()).toBe(false);
    expect(f.client.getAutomationRun).toHaveBeenCalledTimes(1);
  });

  test("filters preserve the selected report and empty history stays reachable after visiting Editor", async () => {
    const f = fixture();
    await open(f);
    f.client.listAutomationRuns.mockResolvedValueOnce(page([]));
    await f.controller.setRunFilters({ status: "succeeded", from: "", to: "" });
    expect(f.controller.snapshot()).toMatchObject({ runs: [], selectedRunId: "run-a",
      run: { id: "run-a" }, lastViewedRunId: "run-a", runsFilters: { status: "succeeded" } });
    await f.controller.openRoute("one");
    expect(f.controller.snapshot()).toMatchObject({ runs: [], selectedRunId: "",
      lastViewedRunId: "run-a", runsFilters: { status: "succeeded" } });
    expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(2);
    await f.controller.openRun(f.controller.snapshot().lastViewedRunId);
    expect(f.controller.snapshot().selectedRunId).toBe("run-a");
    expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(2);
  });

  test("inclusive date filters use local day boundaries, including a 23-hour DST day", async () => {
    vi.stubEnv("TZ", "America/New_York");
    const f = fixture();
    await open(f);
    await f.controller.setRunFilters({ status: "failed", from: "2026-03-08", to: "2026-03-08" });
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", {
      limit: 50, status: "failed", from: "2026-03-08T05:00:00.000Z", to: "2026-03-09T04:00:00.000Z",
    });
    const before = f.controller.snapshot();
    expect(await f.controller.setRunFilters({ from: "2026-03-09", to: "2026-03-08" })).toBe(false);
    expect(await f.controller.setRunFilters({ from: "2026-02-30" })).toBe(false);
    expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot().runs).toEqual(before.runs);
    expect(f.controller.snapshot().runsFilters).toEqual(before.runsFilters);
    expect(f.controller.snapshot().runsFilterError).not.toBe("");
  });

  test("later filters discard old page and filter responses", async () => {
    const f = fixture();
    await open(f);
    const oldPage = deferred<Page>(), oldFilter = deferred<Page>();
    f.client.listAutomationRuns.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(oldFilter.promise)
      .mockResolvedValueOnce(page(["successful"]));
    const pendingPage = f.controller.loadMoreRuns();
    const pendingFilter = f.controller.setRunFilters({ status: "failed" });
    await f.controller.setRunFilters({ status: "succeeded" });
    oldPage.resolve(page(["stale-page"], "cursor-stale"));
    oldFilter.resolve(page(["stale-filter"], "cursor-stale"));
    expect(await pendingPage).toBe(false);
    expect(await pendingFilter).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "successful" }],
      runsNextCursor: null, runsLoading: false, runsFilters: { status: "succeeded" } });
  });

  test("a slow initial selection cannot replace an explicitly applied filter page", async () => {
    const f = fixture();
    const initial = deferred<Page>();
    f.client.listAutomationRuns.mockReturnValueOnce(initial.promise);
    const opening = f.controller.openRoute("one", "run-a");
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["filtered"]));
    await f.controller.setRunFilters({ status: "succeeded" });
    initial.resolve(page(["stale-initial"], "stale-cursor"));
    await opening;
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "filtered" }],
      runsNextCursor: null, runsFilters: { status: "succeeded" }, run: { id: "run-a" } });
  });

  test.each(["automation", "environment"])("%s switches clear filters and reject pending history", async (scope) => {
    const f = fixture();
    await open(f);
    await f.controller.setRunFilters({ status: "failed" });
    const held = deferred<Page>();
    f.client.listAutomationRuns.mockReturnValueOnce(held.promise);
    const pending = f.controller.loadMoreRuns();
    if (scope === "automation") await f.controller.openRoute("two");
    else { f.setEnvironment("prod"); f.controller.environmentChanged(); }
    const before = f.controller.snapshot();
    held.resolve(page(["stale"]));
    expect(await pending).toBe(false);
    expect(f.controller.snapshot().runs).toEqual(before.runs);
    expect(f.controller.snapshot()).toMatchObject({ runsFilters: { status: "", from: "", to: "" },
      runsLoading: false, lastViewedRunId: "" });
  });

  test("page/reset failures preserve rows and manual retry repeats the failed operation", async () => {
    const f = fixture();
    await open(f);
    const previous = f.controller.snapshot();
    f.client.listAutomationRuns.mockRejectedValueOnce(new Error("Offline"));
    expect(await f.controller.loadMoreRuns()).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ runs: previous.runs, runsNextCursor: "cursor-1", runsError: "Offline" });
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["run-c"], "cursor-2"));
    expect(await f.controller.retryRunHistory()).toBe(true);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50, cursor: "cursor-1" });
    f.client.listAutomationRuns.mockRejectedValueOnce(new Error("Offline"));
    expect(await f.controller.resetRunHistory()).toBe(false);
    expect(f.controller.snapshot().runs).toHaveLength(3);
    await f.controller.retryRunHistory();
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50 });
    expect(f.controller.snapshot().runs).toHaveLength(2);
    expect(f.controller.retryRunHistory()).toBe(false);
  });

  test("filter failures retain applied filters, pages and cursor without replacing report error", async () => {
    const f = fixture();
    await open(f);
    f.client.listAutomationRuns.mockRejectedValueOnce(new Error("Offline"));
    expect(await f.controller.setRunFilters({ status: "succeeded" })).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ runsFilters: { status: "" },
      runsNextCursor: "cursor-1", runsFilterError: "Offline", runsError: "", error: "" });
    expect(f.controller.snapshot().runs).toHaveLength(2);
    expect(f.controller.retryRunHistory()).toBe(false);
  });

  test("background report updates preserve older loaded pages and applied filters", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await open(f);
    await f.controller.setRunFilters({ status: "failed" });
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["run-c"]));
    await f.controller.loadMoreRuns();
    const reads = f.client.listAutomationRuns.mock.calls.length;
    f.setRunStatus("succeeded");
    await event(f);
    expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(reads);
    expect(f.controller.snapshot()).toMatchObject({ run: { status: "succeeded" }, runsFilters: { status: "failed" } });
    expect(f.controller.snapshot().runs).toHaveLength(3);
  });

  test("a failed next page keeps its original page boundary through background updates until retry", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await open(f);
    f.client.listAutomationRuns.mockRejectedValueOnce(new Error("Offline"));
    await f.controller.loadMoreRuns();
    const reads = f.client.listAutomationRuns.mock.calls.length;
    f.setRunStatus("succeeded");
    await event(f);
    expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(reads);
    expect(f.controller.snapshot()).toMatchObject({ runsNextCursor: "cursor-1", run: { status: "succeeded" } });
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["run-c"]));
    await f.controller.retryRunHistory();
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50, cursor: "cursor-1" });
    expect(f.controller.snapshot().runs.map((run: { id: string }) => run.id)).toEqual(["run-a", "run-b", "run-c"]);
  });

  test("background first-page refresh respects filters and cannot overwrite a newer filter request", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await open(f);
    await f.controller.setRunFilters({ status: "failed" });
    const stale = deferred<Page>();
    f.client.listAutomationRuns.mockReturnValueOnce(stale.promise);
    await event(f);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50, status: "failed" });
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["new-filter"]));
    await f.controller.setRunFilters({ status: "succeeded" });
    stale.resolve(page(["stale-background"]));
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(f.controller.snapshot().runs).toEqual(page(["new-filter"]).runs);
  });
});

test("run-history HTTP query encodes cursor and filters without changing existing two-argument calls", async () => {
  const requestApi = vi.fn(async () => ({ ok: true }));
  const client = createAutomationRequests({ requestApi, getEnvironmentId: () => "dev",
    getConfig: () => ({ backend: "runtime" }) });
  await client.listAutomationRuns("one two", "dev");
  expect(requestApi).toHaveBeenLastCalledWith("/automations/one%20two/runs?environment=dev", undefined);
  await client.listAutomationRuns("one two", "prod", { limit: 50, cursor: "a+b/c==&x", status: "failed",
    from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" });
  const [url] = requestApi.mock.calls.at(-1) as unknown as [string];
  const params = new URL(url, "http://localhost").searchParams;
  expect(Object.fromEntries(params)).toEqual({ environment: "prod", limit: "50", cursor: "a+b/c==&x",
    status: "failed", from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" });
});
