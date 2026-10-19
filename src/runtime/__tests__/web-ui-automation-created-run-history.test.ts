import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

type RunSummary = { id: string; status: string };
type Page = { runs: RunSummary[]; nextCursor: string | null };
const actions = ["startRun", "rerun"] as const;
const page = (ids: string[], nextCursor: string | null = null, status = "failed"): Page => ({
  runs: ids.map((id) => ({ id, status })), nextCursor,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function fixture() {
  let environment = "dev";
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async () => ({ automations: [{ id: "one" }, { id: "two" }] })),
    getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
    getAutomationDraft: vi.fn(async (automationId: string) => ({ draft: {
      automationId, revision: 1, definition: { title: automationId,
        body: { kind: "sequence", id: "root", children: [] } },
    } })),
    listAutomationRuns: vi.fn(async (_automationId: string, _environmentId: string,
      _query: Record<string, unknown>): Promise<Page> => page(["old-a", "old-b"], "older-cursor")),
    getAutomationRun: vi.fn(async (id: string) => ({ run: {
      id, automationId: "one", status: id === "created" ? "pending" : "failed",
    } })),
    getAutomationStepEvidence: vi.fn(async () => ({ evidence: null })),
    startAutomationRun: vi.fn(async () => ({ run: { id: "created" } })),
    rerunAutomationRun: vi.fn(async () => ({ run: { id: "created" } })),
    stopAutomationRun: vi.fn(async () => ({ run: { id: "old-a" } })),
  };
  const controller = createAutomationsController({ client, render: vi.fn(),
    getEnvironmentId: () => environment, isVisible: () => true });
  return { client, controller, setEnvironment(value: string) { environment = value; } };
}

async function open(f: ReturnType<typeof fixture>) {
  await f.controller.openRoute("one", "old-a");
}

describe("Studio history after creating a run", () => {
  test.each(actions)("%s refreshes an already loaded first page and opens the new report", async (action) => {
    const f = fixture();
    await open(f);
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["created", "old-a"], "new-cursor"));
    expect(await f.controller[action]()).toBe(true);
    expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(2);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50 });
    expect(f.controller.snapshot()).toMatchObject({ selectedRunId: "created", run: { id: "created" },
      runs: [{ id: "created" }, { id: "old-a" }], runsNextCursor: "new-cursor", runsLoading: false });
  });

  test.each(actions)("%s replaces multiple loaded pages with a fresh cursor boundary", async (action) => {
    const f = fixture();
    await open(f);
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["old-c"], "old-page-two"));
    await f.controller.loadMoreRuns();
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["created", "old-a"], "new-cursor"));
    expect(await f.controller[action]()).toBe(true);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50 });
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "created" }, { id: "old-a" }],
      runsNextCursor: "new-cursor", selectedRunId: "created" });
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["old-b", "old-c"]));
    expect(await f.controller.loadMoreRuns()).toBe(true);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50, cursor: "new-cursor" });
    expect(f.controller.snapshot().runs.map((run: RunSummary) => run.id))
      .toEqual(["created", "old-a", "old-b", "old-c"]);
  });

  test.each(actions)("%s retains applied filters and opens a new report outside those results", async (action) => {
    const f = fixture();
    await open(f);
    await f.controller.setRunFilters({ status: "failed", from: "2026-10-01", to: "2026-10-02" });
    const filteredQuery = f.client.listAutomationRuns.mock.calls.at(-1)![2];
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["matching-old"]));
    expect(await f.controller[action]()).toBe(true);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", filteredQuery);
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "matching-old" }],
      runsFilters: { status: "failed", from: "2026-10-01", to: "2026-10-02" },
      selectedRunId: "created", run: { id: "created", status: "pending" } });
  });

  test("creation replaces a failed next-page read and clears its obsolete retry", async () => {
    const f = fixture();
    await open(f);
    f.client.listAutomationRuns.mockRejectedValueOnce(new Error("Old page offline"));
    expect(await f.controller.loadMoreRuns()).toBe(false);
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["created"], "fresh-cursor"));
    expect(await f.controller.startRun()).toBe(true);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50 });
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "created" }],
      runsNextCursor: "fresh-cursor", runsError: "", runsLoading: false });
    expect(f.controller.retryRunHistory()).toBe(false);
  });

  test("a failed creation refresh preserves history and retries the first page, never the old cursor", async () => {
    const f = fixture();
    await open(f);
    f.client.listAutomationRuns.mockRejectedValueOnce(new Error("Old page offline"));
    await f.controller.loadMoreRuns();
    const before = f.controller.snapshot().runs;
    f.client.listAutomationRuns.mockRejectedValueOnce(new Error("Refresh offline"));
    expect(await f.controller.startRun()).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ runs: before, runsError: "Refresh offline", runsLoading: false,
      selectedRunId: "created", run: { id: "created" } });
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["created"], "fresh-cursor"));
    expect(await f.controller.retryRunHistory()).toBe(true);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", { limit: 50 });
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "created" }],
      runsNextCursor: "fresh-cursor", runsError: "" });
  });

  test("a pending older page cannot append after creation refreshed the history", async () => {
    const f = fixture();
    await open(f);
    const oldPage = deferred<Page>();
    f.client.listAutomationRuns.mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(page(["created"], "fresh-cursor"));
    const pendingPage = f.controller.loadMoreRuns();
    expect(await f.controller.startRun()).toBe(true);
    oldPage.resolve(page(["obsolete-old-page"], "obsolete-cursor"));
    expect(await pendingPage).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "created" }],
      runsNextCursor: "fresh-cursor", runsLoading: false });
  });

  test("creation refresh preserves a pending filter request and rejects its older response", async () => {
    const f = fixture();
    await open(f);
    const oldFilter = deferred<Page>();
    f.client.listAutomationRuns.mockReturnValueOnce(oldFilter.promise)
      .mockResolvedValueOnce(page(["created"], "filtered-cursor", "pending"));
    const pendingFilter = f.controller.setRunFilters({ status: "pending", from: "2026-10-01", to: "2026-10-02" });
    const requestedQuery = f.client.listAutomationRuns.mock.calls.at(-1)![2];
    expect(await f.controller.startRun()).toBe(true);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", requestedQuery);
    oldFilter.resolve(page(["obsolete-filter"], "obsolete-cursor", "pending"));
    expect(await pendingFilter).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "created" }],
      runsNextCursor: "filtered-cursor", runsLoading: false,
      runsFilters: { status: "pending", from: "2026-10-01", to: "2026-10-02" } });
  });

  test("a failed refresh of pending filters retains applied results and retries the requested first page", async () => {
    const f = fixture();
    await open(f);
    await f.controller.setRunFilters({ status: "failed" });
    const before = f.controller.snapshot();
    const oldFilter = deferred<Page>();
    f.client.listAutomationRuns.mockReturnValueOnce(oldFilter.promise)
      .mockRejectedValueOnce(new Error("Refresh offline"));
    const pendingFilter = f.controller.setRunFilters({ status: "pending", from: "2026-10-01", to: "2026-10-02" });
    const requestedQuery = f.client.listAutomationRuns.mock.calls.at(-1)![2];
    expect(await f.controller.startRun()).toBe(true);
    oldFilter.resolve(page(["obsolete-filter"], "obsolete-cursor", "pending"));
    expect(await pendingFilter).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ runs: before.runs, runsFilters: before.runsFilters,
      runsNextCursor: before.runsNextCursor, runsError: "Refresh offline", runsFilterError: "",
      runsLoading: false, selectedRunId: "created", run: { id: "created" } });
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["created"], "fresh-filter-cursor", "pending"));
    expect(await f.controller.retryRunHistory()).toBe(true);
    expect(f.client.listAutomationRuns).toHaveBeenLastCalledWith("one", "dev", requestedQuery);
    expect(requestedQuery).not.toHaveProperty("cursor");
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "created" }],
      runsNextCursor: "fresh-filter-cursor", runsError: "",
      runsFilters: { status: "pending", from: "2026-10-01", to: "2026-10-02" } });
  });

  test.each(["success", "failure"])("later filters supersede a creation refresh %s", async (outcome) => {
    const f = fixture();
    await open(f);
    const oldRefresh = deferred<Page>();
    f.client.listAutomationRuns.mockReturnValueOnce(oldRefresh.promise);
    const pending = f.controller.startRun();
    await settle();
    expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(2);
    f.client.listAutomationRuns.mockResolvedValueOnce(page(["new-filter"], "new-filter-cursor", "succeeded"));
    await f.controller.setRunFilters({ status: "succeeded" });
    if (outcome === "success") oldRefresh.resolve(page(["obsolete-refresh"], "obsolete-cursor"));
    else oldRefresh.reject(new Error("Obsolete refresh failed"));
    await pending;
    expect(f.controller.snapshot()).toMatchObject({ runs: [{ id: "new-filter" }],
      runsNextCursor: "new-filter-cursor", runsFilters: { status: "succeeded" },
      runsError: "", runsFilterError: "", runsLoading: false });
  });

  test.each(["run", "automation", "environment"])(
    "%s navigation prevents a creation refresh from replacing history or opening its report", async (destination) => {
      const f = fixture();
      await open(f);
      const oldRefresh = deferred<Page>();
      f.client.listAutomationRuns.mockReturnValueOnce(oldRefresh.promise);
      const pending = f.controller.startRun();
      await settle();
      expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(2);
      if (destination === "run") await f.controller.openRun("chosen");
      if (destination === "automation") await f.controller.openRoute("two");
      if (destination === "environment") {
        f.setEnvironment("prod");
        f.controller.environmentChanged();
      }
      const before = f.controller.snapshot();
      const reads = f.client.getAutomationRun.mock.calls.length;
      oldRefresh.resolve(page(["obsolete-refresh"], "obsolete-cursor"));
      expect(await pending).toBe(false);
      expect(f.controller.snapshot()).toMatchObject({ runs: before.runs,
        runsNextCursor: before.runsNextCursor, selectedRunId: before.selectedRunId,
        selectedAutomationId: before.selectedAutomationId, runsLoading: false });
      expect(f.client.getAutomationRun).toHaveBeenCalledTimes(reads);
    },
  );

  test.each(["success", "failure"])("a newer mutation invalidates a pending history refresh %s", async (outcome) => {
    const f = fixture();
    await open(f);
    const oldRefresh = deferred<Page>(), stop = deferred<{ run: { id: string } }>();
    f.client.listAutomationRuns.mockReturnValueOnce(oldRefresh.promise);
    const pending = f.controller.startRun();
    await settle();
    expect(f.client.listAutomationRuns).toHaveBeenCalledTimes(2);
    f.client.stopAutomationRun.mockReturnValueOnce(stop.promise);
    const newer = f.controller.stopRun();
    const before = f.controller.snapshot();
    expect(before.mutation).toBe("Stop request");
    if (outcome === "success") oldRefresh.resolve(page(["obsolete-refresh"], "obsolete-cursor"));
    else oldRefresh.reject(new Error("Obsolete refresh failed"));
    expect(await pending).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ runs: before.runs,
      runsNextCursor: before.runsNextCursor, runsError: "", error: "",
      runsLoading: false, mutation: "Stop request", selectedRunId: "old-a" });
    expect(f.client.getAutomationRun).toHaveBeenCalledTimes(1);
    stop.resolve({ run: { id: "old-a" } });
    expect(await newer).toBe(true);
  });
});
