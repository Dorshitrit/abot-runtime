import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { ScheduleManagementRoutes } from "../../web-ui/local-runtime/schedule-management-routes.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import type { RuntimeConfig } from "../ports.js";
import type { SchedulerRun, SchedulerService } from "../scheduler/contracts.js";
import { querySchedulerRuns } from "../scheduler/run-list-query.js";

function run(id: string, jobId: string, scheduledAt: string): SchedulerRun {
  return {
    id,
    jobId,
    environmentId: "dev",
    sessionId: `session-${jobId}`,
    requestId: `request-${id}`,
    title: `Job ${jobId}`,
    prompt: `Saved prompt ${id}`,
    modelProfileId: "primary",
    agentMode: "fast",
    timeZone: "UTC",
    jobRevision: 1,
    scheduledAt,
    trigger: "schedule",
    status: "succeeded",
    resultText: `Saved result ${id}`,
    resultMessageId: `message-${id}`,
  };
}

function fixture() {
  const runs = [
    run("a1", "a", "2026-09-06T08:00:00Z"),
    run("b1", "b", "2026-09-06T09:00:00Z"),
    run("a2", "a", "2026-09-06T10:00:00Z"),
    run("b2", "b", "2026-09-06T11:00:00Z"),
  ];
  const listRuns = vi.fn<SchedulerService["listRuns"]>(async (jobId, query) =>
    querySchedulerRuns(runs, jobId, query),
  );
  const get = vi.fn(async () => null);
  const start = vi.fn(async () => {});
  const resolve = vi.fn((environmentId: string) => {
    if (environmentId !== "dev") throw new Error("unknown_environment");
    return {
      start,
      services: {
        config: {} as RuntimeConfig,
        scheduler: { listRuns, get } as unknown as SchedulerService,
      },
    };
  });
  return {
    runs,
    routes: new ScheduleManagementRoutes(resolve),
    listRuns,
    get,
    resolve,
    start,
  };
}

async function request(
  routes: ScheduleManagementRoutes,
  path = "/schedules/runs",
  environmentId = "dev",
  method = "GET",
) {
  let status = 0;
  let raw = "";
  const headers: Record<string, string> = {};
  const url = new URL(path, "http://localhost");
  const response = {
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
    writeHead: (value: number) => {
      status = value;
    },
    end: (value: string) => {
      raw = value;
    },
  } as unknown as ServerResponse;
  await routes.handle({
    method,
    segments: url.pathname.split("/").filter(Boolean),
    url,
    body: null,
    environmentId,
    response,
  });
  const data = JSON.parse(raw) as {
    runs?: SchedulerRun[];
    nextCursor?: string | null;
    error?: string;
  };
  return { status, data, headers };
}

describe("Dashboard recent schedule activity transport", () => {
  it("pages canonical runs across Jobs with a bounded owner query and retained deep links", async () => {
    const f = fixture();
    const first = await request(f.routes, "/schedules/runs?limit=2");
    expect(first.status).toBe(200);
    expect(first.data.runs).toEqual([f.runs[3], f.runs[2]]);
    expect(first.data.nextCursor).toBe("a2");
    expect(f.listRuns).toHaveBeenLastCalledWith(undefined, {
      limit: 3,
      cursor: undefined,
    });
    const second = await request(f.routes, "/schedules/runs?limit=2&cursor=a2");
    expect(second.data.runs).toEqual([f.runs[1], f.runs[0]]);
    expect(second.data.nextCursor).toBeNull();
    expect(f.listRuns).toHaveBeenLastCalledWith(undefined, {
      limit: 3,
      cursor: "a2",
    });
    expect(f.get).not.toHaveBeenCalled();
  });

  it("uses the requested environment and waits for its readiness", async () => {
    const f = fixture();
    let ready!: () => void;
    f.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const pending = request(f.routes, "/schedules/runs?limit=8");
    expect(f.listRuns).not.toHaveBeenCalled();
    ready();
    expect((await pending).status).toBe(200);
    expect(f.resolve).toHaveBeenCalledWith("dev");
    f.listRuns.mockClear();
    expect((await request(f.routes, "/schedules/runs", "unknown")).status).toBe(
      400,
    );
    expect(f.listRuns).not.toHaveBeenCalled();
  });

  it("uses existing page limits and errors without unbounded fallback reads", async () => {
    const f = fixture();
    await request(f.routes);
    expect(f.listRuns).toHaveBeenLastCalledWith(undefined, {
      limit: 51,
      cursor: undefined,
    });
    await request(f.routes, "/schedules/runs?limit=100");
    expect(f.listRuns).toHaveBeenLastCalledWith(undefined, {
      limit: 101,
      cursor: undefined,
    });
    for (const limit of ["0", "101", "1.5", "invalid"]) {
      expect(
        (await request(f.routes, `/schedules/runs?limit=${limit}`)).status,
      ).toBe(400);
    }
    expect(f.listRuns).toHaveBeenCalledTimes(2);
    const missing = await request(f.routes, "/schedules/runs?cursor=missing");
    expect(missing.status).toBe(404);
    expect(missing.data.error).toBe("scheduler_run_cursor_not_found");
  });

  it("rejects collection mutations and reports owner failures instead of an empty feed", async () => {
    const f = fixture();
    const rejected = await request(f.routes, "/schedules/runs", "dev", "POST");
    expect(rejected.status).toBe(405);
    expect(rejected.headers.allow).toBe("GET");
    expect(f.listRuns).not.toHaveBeenCalled();
    f.listRuns.mockRejectedValueOnce(new Error("scheduler_stopped"));
    const failed = await request(f.routes);
    expect(failed.status).toBe(409);
    expect(failed.data.runs).toBeUndefined();
  });

  it("encodes the environment and page while retaining Job-scoped client requests", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ runs: [], nextCursor: null })),
    );
    const client = createRuntimeWebClient({
      getConfig: () => ({ backend: "runtime" }),
      getEnvironmentId: () => "default environment",
      origin: "http://localhost",
      fetchImpl,
    });
    await client.listRecentScheduleRuns("dev / one", {
      limit: 8,
      cursor: "run /?",
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/web-api/schedules/runs?environment=dev%20%2F%20one&cursor=run+%2F%3F&limit=8",
      expect.anything(),
    );
    await client.listRecentScheduleRuns();
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/web-api/schedules/runs?environment=default%20environment",
      expect.anything(),
    );
    await client.listScheduleRuns("job/a", undefined, { limit: 2 });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/web-api/schedules/job%2Fa/runs?environment=default%20environment&limit=2",
      expect.anything(),
    );
  });

  it("blocks recent activity calls locally for bridge backends", async () => {
    const fetchImpl = vi.fn();
    const client = createRuntimeWebClient({
      getConfig: () => ({ backend: "bridge" }),
      getEnvironmentId: () => "dev",
      origin: "http://localhost",
      fetchImpl,
    });
    await expect(client.listRecentScheduleRuns()).rejects.toThrow(
      "Schedules require the local Runtime backend.",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
