import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRoutes } from "../../web-ui/local-runtime/automation-routes.js";
import type { AutomationService } from "../automations/service.js";
import type { RuntimeEnvironmentServices } from "../composition.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import { createLocalServiceClients } from "../local-host/client-services.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import type { SchedulerAutomationRun } from "../scheduler/contracts.js";
import { makeAutomationSchedulerRun } from "../scheduler/automation-run-records.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(count = 1_005) {
  const directory = await mkdtemp(join(tmpdir(), "automation-run-pages-"));
  const store = createFileSchedulerStore(directory);
  const scheduler = createSchedulerService({
    environmentId: "test", store, now: () => Date.parse("2026-10-15T00:00:00Z"), tickIntervalMs: 1_000_000,
    executor: { sessionExists: async () => true, tryReserve: () => null, start: vi.fn() },
  });
  cleanups.push(async () => { await scheduler.stop(); await rm(directory, { recursive: true, force: true }); });
  await scheduler.start();
  const job = await scheduler.createAutomationJob({ automationId: "automation", definitionRevision: 1,
    title: "Retained history", timeZone: "UTC", schedule: { kind: "manual" } });
  const foreign = await scheduler.createAutomationJob({ automationId: "foreign", definitionRevision: 1,
    title: "Another automation", timeZone: "UTC", schedule: { kind: "manual" } });
  const runs = Array.from({ length: count }, (_, index): SchedulerAutomationRun => ({
    ...makeAutomationSchedulerRun(job, `run-${String(index).padStart(4, "0")}`,
      new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(), "manual"),
    status: index % 4 === 0 ? "failed" : "succeeded",
  }));
  await store.update((state) => { state.runs.push(...runs,
    { ...makeAutomationSchedulerRun(foreign, "foreign-run", "2026-10-02T00:00:00Z", "manual"), status: "failed" }); });
  const listRuns = vi.fn(scheduler.listAutomationRuns.bind(scheduler));
  const service = { listRuns } as unknown as AutomationService;
  const connection = await createLocalRuntimeConnection({
    directory: join(directory, "local-host"), identity: "automation-run-history-test",
    createOwner: async () => ({
      call: (method, args) => dispatchLocalServiceCall(
        { automations: service } as RuntimeEnvironmentServices, method, args),
      subscribe: () => () => {}, stop: () => scheduler.stop(),
    }),
  });
  cleanups.push(() => connection.close());
  const clients = createLocalServiceClients(connection.call);
  const routes = new AutomationRoutes(() => ({ start: async () => {}, services: clients }));
  return { routes, runs, listRuns };
}

async function request(routes: AutomationRoutes, params = new URLSearchParams()) {
  let status = 0;
  let raw = "";
  const url = new URL(`/automations/automation/runs?${params}`, "http://localhost");
  const response = {
    setHeader() {}, writeHead(value: number) { status = value; }, end(value: string) { raw = value; },
  } as unknown as ServerResponse;
  await routes.handle({ method: "GET", segments: url.pathname.split("/").filter(Boolean), url,
    body: null, environmentId: "test", request: {} as IncomingMessage, response });
  return { status, data: JSON.parse(raw) as { runs: SchedulerAutomationRun[]; nextCursor: string | null; error?: string } };
}

describe("automation run history pages", () => {
  it("filters retained index metadata and bounds every real owner response while traversing 1,005 records", async () => {
    const f = await fixture();
    const params = new URLSearchParams({ status: "failed", from: f.runs[100].scheduledAt, to: f.runs[1_000].scheduledAt });
    const found: string[] = [];
    for (;;) {
      const page = await request(f.routes, params);
      expect(page.status).toBe(200);
      expect(page.data.runs.length).toBeLessThanOrEqual(50);
      expect((await f.listRuns.mock.results.at(-1)!.value).length).toBeLessThanOrEqual(51);
      found.push(...page.data.runs.map((run) => run.id));
      if (!page.data.nextCursor) break;
      expect(page.data.nextCursor).toBe(page.data.runs.at(-1)!.id);
      params.set("cursor", page.data.nextCursor);
    }
    expect(found).toEqual(f.runs.slice(100, 1_000).filter((run) => run.status === "failed").reverse().map((run) => run.id));
    expect(found).toHaveLength(225);
    const maximum = await request(f.routes, new URLSearchParams({ limit: "100" }));
    expect(maximum.data.runs).toHaveLength(100);
    expect(maximum.data.runs[0]).toEqual(f.runs.at(-1));
    expect(f.listRuns).toHaveBeenLastCalledWith("automation", expect.objectContaining({ limit: 101 }));
    const empty = await request(f.routes, new URLSearchParams({ status: "interrupted" }));
    expect(empty.data).toEqual({ ok: true, runs: [], nextCursor: null });
    const single = await request(f.routes, new URLSearchParams({ from: f.runs.at(-1)!.scheduledAt }));
    expect(single.data.runs).toEqual([f.runs.at(-1)]);
    expect(single.data.nextCursor).toBeNull();
  });

  it("rejects bad filters before owner calls and rejects foreign cursors", async () => {
    const f = await fixture(3);
    const invalidQueries: Record<string, string>[] = [
      { status: "rejected" }, { from: "2026-02-30T00:00:00Z" }, { to: "today" },
      { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" },
      { limit: "101" }, { limit: "0" }, { limit: "1.5" },
    ];
    for (const params of invalidQueries)
      expect((await request(f.routes, new URLSearchParams(params))).status).toBe(400);
    expect(f.listRuns).not.toHaveBeenCalled();
    for (const cursor of ["foreign-run", "missing"])
      expect((await request(f.routes, new URLSearchParams({ cursor }))).status).toBe(404);
  });
});
