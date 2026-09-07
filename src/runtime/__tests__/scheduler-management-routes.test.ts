import type { ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeApplication } from "../composition.js";
import type { SchedulerJob, SchedulerService } from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import type { JsonObject } from "../../web-ui/local-runtime/contracts.js";
import { ScheduleManagementRoutes } from "../../web-ui/local-runtime/schedule-management-routes.js";

const resources: { service: SchedulerService; directory: string }[] = [];
const jobInput = {
  sessionId: "chat-a",
  title: "Read the news",
  prompt: "Read today's news",
  modelProfileId: "primary",
  agentMode: "fast",
  timeZone: "Asia/Jerusalem",
  schedule: { kind: "weekly", at: "09:00", weekdays: [3, 6] },
};
async function createRoutes() {
  const directory = await mkdtemp(join(tmpdir(), "abot-schedule-routes-"));
  const service = createSchedulerService({
    environmentId: "development",
    store: createFileSchedulerStore(directory),
    now: () => Date.parse("2026-09-05T10:00:00Z"),
    tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async (id) => ["chat-a", "chat-b"].includes(id),
      tryReserve: () => () => undefined,
      start: async () => ({ status: "succeeded", resultText: "done" }),
    },
  });
  resources.push({ service, directory });
  const application = {
    services: {
      scheduler: service,
      config: {
        models: {
          profiles: {
            primary: { model: "primary-test-model" },
            secondary: { model: "secondary-test-model" },
          },
          defaults: { profileId: "primary" },
        },
      },
    },
    start: () => service.start(),
  } as unknown as RuntimeApplication;
  const routes = new ScheduleManagementRoutes((id) => {
    if (id !== "development") throw new Error("unknown_environment");
    return application;
  });
  return { service, routes };
}
async function request(
  routes: ScheduleManagementRoutes,
  method: string,
  path = "/web-api/schedules",
  body: JsonObject | null = null,
) {
  let status = 0;
  let data: Record<string, any> = {};
  const headers: Record<string, string> = {};
  const response = {
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
    writeHead: (code: number) => {
      status = code;
    },
    end: (raw: string) => {
      data = JSON.parse(raw);
    },
  } as unknown as ServerResponse;
  const url = new URL(path, "http://local.test");
  const handled = await routes.handle({
    method,
    segments: url.pathname.split("/").filter(Boolean).slice(1),
    url,
    body,
    environmentId: "development",
    response,
  });
  return { status, data, headers, handled };
}
afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ service, directory }) => {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("scheduler management routes with persisted domain service", () => {
  it("creates, lists, gets, and edits one canonical Job with fixed FULL authority", async () => {
    const { routes, service } = await createRoutes();
    const created = await request(routes, "POST", undefined, {
      ...jobInput,
      toolPermissionMode: "ask",
      environmentId: "injected",
      id: "injected",
    });
    expect(created.status).toBe(201);
    const job = created.data.job as SchedulerJob;
    expect(job).toMatchObject({
      sessionId: "chat-a",
      environmentId: "development",
      modelProfileId: "primary",
      toolPermissionMode: "full_access",
    });
    expect(job.id).not.toBe("injected");
    const listed = await request(routes, "GET");
    expect(listed.data.jobs).toEqual([job]);
    expect(
      (await request(routes, "GET", `/web-api/schedules/${job.id}`)).data.job,
    ).toEqual(job);
    const edited = await request(
      routes,
      "PATCH",
      `/web-api/schedules/${job.id}`,
      {
        title: "Updated",
        modelProfileId: "secondary",
        agentMode: "deep",
        sessionId: "chat-b",
        toolPermissionMode: "ask",
        id: "changed",
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.data.job).toMatchObject({
      id: job.id,
      sessionId: "chat-a",
      title: "Updated",
      modelProfileId: "secondary",
      agentMode: "deep",
      toolPermissionMode: "full_access",
      revision: 2,
    });
    expect(await service.get(job.id)).toEqual(edited.data.job);
  });
  it("uses the same records for pause, resume, run-now, runs, and cancel", async () => {
    const { routes } = await createRoutes();
    const created = await request(routes, "POST", undefined, jobInput);
    const path = `/web-api/schedules/${created.data.job.id}`;
    expect(
      (await request(routes, "POST", path + "/pause")).data.job.state,
    ).toBe("paused");
    const manual = await request(routes, "POST", path + "/run-now");
    expect(manual.data.run).toMatchObject({
      status: "pending",
      trigger: "manual",
      prompt: jobInput.prompt,
    });
    expect((await request(routes, "GET", path + "/runs")).data.runs).toEqual([
      manual.data.run,
    ]);
    expect(
      (await request(routes, "POST", path + "/resume")).data.job.state,
    ).toBe("active");
    expect(
      (await request(routes, "POST", path + "/cancel")).data.job.state,
    ).toBe("cancelled");
    const rejected = await request(routes, "POST", path + "/run-now");
    expect(rejected.status).toBe(400);
    expect(rejected.data.error).toBe("scheduler_job_cancelled");
  });
  it("filters by exact session and state and searchable text", async () => {
    const { routes } = await createRoutes();
    const first = await request(routes, "POST", undefined, jobInput);
    await request(routes, "POST", undefined, {
      ...jobInput,
      sessionId: "chat-b",
      title: "Other",
    });
    await request(
      routes,
      "POST",
      `/web-api/schedules/${first.data.job.id}/pause`,
    );
    const filtered = await request(
      routes,
      "GET",
      "/web-api/schedules?sessionId=chat-a&state=paused&search=NEWS",
    );
    expect(filtered.data.jobs.map((job: SchedulerJob) => job.id)).toEqual([
      first.data.job.id,
    ]);
    expect(
      (
        await request(
          routes,
          "GET",
          "/web-api/schedules?sessionId=chat-a&state=active",
        )
      ).data.jobs,
    ).toEqual([]);
  });
  it("rejects unknown models without silently substituting the configured default", async () => {
    const { routes, service } = await createRoutes();
    const badCreate = await request(routes, "POST", undefined, {
      ...jobInput,
      modelProfileId: "missing",
    });
    expect(badCreate.status).toBe(400);
    expect(badCreate.data.error).toBe("scheduler_model_unavailable");
    expect(await service.list()).toEqual([]);
    const created = await request(routes, "POST", undefined, jobInput);
    const before = created.data.job;
    const badEdit = await request(
      routes,
      "PATCH",
      `/web-api/schedules/${before.id}`,
      {
        title: "Must not persist",
        modelProfileId: "missing",
      },
    );
    expect(badEdit.status).toBe(400);
    expect(await service.get(before.id)).toEqual(before);
  });
  it("rejects invalid time and timezone with 400 and no partial Job", async () => {
    const { routes, service } = await createRoutes();
    for (const override of [
      { schedule: { kind: "daily", at: "morning" } },
      { schedule: { kind: "interval", everyMs: 0 } },
      { timeZone: "not/a/timezone" },
      { prompt: "" },
    ]) {
      const response = await request(routes, "POST", undefined, {
        ...jobInput,
        ...override,
      });
      expect(response.status).toBe(400);
      expect(response.data.ok).toBe(false);
      expect(await service.list()).toEqual([]);
    }
    const created = await request(routes, "POST", undefined, jobInput);
    const invalidEdit = await request(
      routes,
      "PATCH",
      `/web-api/schedules/${created.data.job.id}`,
      {
        title: "Must not persist",
        schedule: { kind: "monthly", dayOfMonth: 32, at: "09:00" },
      },
    );
    expect(invalidEdit.status).toBe(400);
    expect(await service.get(created.data.job.id)).toEqual(created.data.job);
  });
  it("rejects nonexistent sessions and Jobs with 404 without creating a session", async () => {
    const { routes, service } = await createRoutes();
    const response = await request(routes, "POST", undefined, {
      ...jobInput,
      sessionId: "deleted-chat",
    });
    expect(response.status).toBe(404);
    expect(response.data.error).toBe("scheduler_session_not_found");
    expect(await service.list()).toEqual([]);
    expect(
      (await request(routes, "GET", "/web-api/schedules/missing")).status,
    ).toBe(404);
  });
  it("rejects unsupported methods and leaves unrelated routes untouched", async () => {
    const { routes } = await createRoutes();
    const unsupported = await request(routes, "DELETE");
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.allow).toBe("GET, POST");
    const unrelated = await request(routes, "GET", "/web-api/other");
    expect(unrelated.handled).toBe(false);
    expect(unrelated.status).toBe(0);
  });
});
