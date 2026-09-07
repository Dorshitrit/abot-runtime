import type { ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleManagementRoutes } from "../../web-ui/local-runtime/schedule-management-routes.js";
import type { RuntimeEnvironmentServices } from "../composition.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import { createLocalServiceClients } from "../local-host/client-services.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import type { RuntimeConfig } from "../ports.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { makeSchedulerRun } from "../scheduler/run-records.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(count = 205) {
  const directory = await mkdtemp(join(tmpdir(), "scheduler-run-pages-"));
  const store = createFileSchedulerStore(directory);
  const service = createSchedulerService({
    environmentId: "test",
    store,
    now: () => Date.parse("2026-09-06T10:00:00Z"),
    tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async () => true,
      tryReserve: () => () => undefined,
      start: async () => ({ status: "succeeded" }),
    },
  });
  cleanups.push(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await service.start();
  const job = await service.create({
    sessionId: "session",
    title: "History",
    prompt: "Exact retained prompt",
    modelProfileId: "model",
    agentMode: "fast",
    timeZone: "UTC",
    schedule: { kind: "daily", at: "11:00" },
  });
  const foreign = await service.create({ ...job, sessionId: "other" });
  const runs = Array.from(
    { length: count },
    (_, index): SchedulerRun => ({
      ...makeSchedulerRun(
        job,
        new Date(
          Date.parse("2026-09-01T10:00:00Z") + index * 1000,
        ).toISOString(),
        "schedule",
      ),
      status: "succeeded",
      resultText: `Result ${index} ` + "x".repeat(2048),
    }),
  );
  const foreignRun = makeSchedulerRun(
    foreign,
    "2026-09-05T10:00:00.000Z",
    "schedule",
  );
  await store.update((state) => {
    state.runs.push(...runs, foreignRun);
  });
  return { directory, store, service, job, runs, foreignRun };
}

async function request(
  routes: ScheduleManagementRoutes,
  jobId: string,
  query = "",
) {
  let status = 0;
  let raw = "";
  const url = new URL(`/schedules/${jobId}/runs${query}`, "http://localhost");
  const response = {
    setHeader: () => {},
    writeHead: (value: number) => {
      status = value;
    },
    end: (value: string) => {
      raw = value;
    },
  } as unknown as ServerResponse;
  await routes.handle({
    method: "GET",
    segments: url.pathname.split("/").filter(Boolean),
    url,
    body: null,
    environmentId: "test",
    response,
  });
  return {
    status,
    raw,
    data: JSON.parse(raw) as {
      runs: SchedulerRun[];
      nextCursor: string | null;
      error?: string;
    },
  };
}

describe("bounded retained run queries", () => {
  it("preserves legacy reads and traverses newest-first pages without duplicates", async () => {
    const f = await fixture();
    expect(await f.service.listRuns(f.job.id)).toEqual(f.runs);
    const found: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const runs = await f.service.listRuns(f.job.id, { limit: 50, cursor });
      expect(runs.length).toBeLessThanOrEqual(50);
      found.push(...runs.map((run) => run.id));
      if (runs.length < 50) break;
      cursor = runs.at(-1)!.id;
    }
    expect(found).toEqual([...f.runs].reverse().map((run) => run.id));
    expect(new Set(found).size).toBe(205);
  });

  it("keeps an older cursor stable when a newer run arrives and rejects foreign or invalid queries", async () => {
    const f = await fixture(5);
    const first = await f.service.listRuns(f.job.id, { limit: 2 });
    await f.store.update((state) => {
      state.runs.push(
        makeSchedulerRun(f.job, "2026-09-06T10:00:00.000Z", "manual"),
      );
    });
    const second = await f.service.listRuns(f.job.id, {
      limit: 2,
      cursor: first[1].id,
    });
    expect(second.map((run) => run.id)).toEqual([f.runs[2].id, f.runs[1].id]);
    for (const cursor of [f.foreignRun.id, "missing", ""])
      await expect(
        f.service.listRuns(f.job.id, { limit: 2, cursor }),
      ).rejects.toThrow("scheduler_run_cursor");
    for (const limit of [0, 102, 1.5, Number.NaN])
      await expect(f.service.listRuns(f.job.id, { limit })).rejects.toThrow(
        "scheduler_run_page_limit_invalid",
      );
  });

  it("bounds the actual owner RPC response before serializing a Web page and keeps every older run reachable", async () => {
    const f = await fixture();
    const list = vi.spyOn(f.service, "listRuns");
    const connection = await createLocalRuntimeConnection({
      directory: join(f.directory, "local-host"),
      identity: "run-history-test",
      createOwner: async () => ({
        call: (method, args) =>
          dispatchLocalServiceCall(
            { scheduler: f.service } as RuntimeEnvironmentServices,
            method,
            args,
          ),
        subscribe: () => () => {},
        stop: () => f.service.stop(),
      }),
    });
    cleanups.push(() => connection.close());
    const clients = createLocalServiceClients(connection.call);
    const routes = new ScheduleManagementRoutes(() => ({
      start: async () => {},
      services: { ...clients, config: {} as RuntimeConfig },
    }));
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await request(
        routes,
        f.job.id,
        cursor ? `?cursor=${cursor}` : "",
      );
      expect(page.status).toBe(200);
      expect(page.data.runs.length).toBeLessThanOrEqual(50);
      expect(page.raw.length).toBeLessThan(150_000);
      expect(
        (await list.mock.results.at(-1)!.value).length,
      ).toBeLessThanOrEqual(51);
      found.push(...page.data.runs.map((run) => run.id));
      cursor = page.data.nextCursor;
    } while (cursor);
    expect(found).toEqual([...f.runs].reverse().map((run) => run.id));
    const maximum = await request(routes, f.job.id, "?limit=100");
    expect(maximum.data.runs).toHaveLength(100);
    expect(list).toHaveBeenLastCalledWith(f.job.id, {
      limit: 101,
      cursor: undefined,
    });
    expect(maximum.data.runs[0]).toEqual(f.runs.at(-1));
    expect((await request(routes, f.job.id, "?limit=101")).status).toBe(400);
    expect(
      (await request(routes, f.job.id, `?cursor=${f.foreignRun.id}`)).status,
    ).toBe(404);
  });
});
