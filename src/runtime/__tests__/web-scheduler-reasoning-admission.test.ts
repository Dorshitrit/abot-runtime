import type { ServerResponse } from "node:http";
import { afterEach, expect, test } from "vitest";
import type { JsonObject } from "../../web-ui/local-runtime/contracts.js";
import { ScheduleManagementRoutes } from "../../web-ui/local-runtime/schedule-management-routes.js";
import type { SchedulerJob } from "../scheduler/contracts.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const input = {
  sessionId: "session", title: "Reminder", prompt: "Remind me to act",
  modelProfileId: "scheduled-model", agentMode: "fast", timeZone: "UTC",
  schedule: { kind: "timer", delayMs: 3_600_000 },
};

async function request(routes: ScheduleManagementRoutes, method: string, body: JsonObject, jobId?: string) {
  let status = 0;
  let data: { ok: boolean; error?: string; job?: SchedulerJob } = { ok: false };
  const response = {
    setHeader() {},
    writeHead(code: number) { status = code; },
    end(raw: string) { data = JSON.parse(raw); },
  } as unknown as ServerResponse;
  await routes.handle({ method, body, response, environmentId: "scheduler-integration",
    url: new URL("http://local.test/web-api/schedules"),
    segments: jobId ? ["schedules", jobId] : ["schedules"],
  });
  return { status, data };
}

test("HTTP returns 400 for incompatible create/edit controls without persisting a partial Job", async () => {
  const f = await createSchedulerRuntimeFixture();
  cleanups.push(f.dispose);
  f.config.models!.providers!.local.type = "openai";
  f.config.models!.profiles!["scheduled-model"].supportsThinking = true;
  const routes = new ScheduleManagementRoutes(() => f.application);
  for (const mode of ["off", "server-default", "budget"]) {
    const reasoningPreference = { profileId: "scheduled-model", mode,
      ...(mode === "budget" ? { budgetTokens: 128 } : {}) };
    const response = await request(routes, "POST", { ...input, reasoningPreference });
    expect(response.status).toBe(400);
    expect(response.data).toMatchObject({ ok: false, error: "reasoning_budget_unsupported" });
    expect(await f.scheduler.list()).toEqual([]);
  }
  const created = await request(routes, "POST", input);
  expect(created.status).toBe(201);
  const job = created.data.job!;
  const invalid = await request(routes, "PATCH", { title: "Rejected", reasoningPreference: {
    profileId: "scheduled-model", mode: "off",
  } }, job.id);
  expect(invalid.status).toBe(400);
  expect(invalid.data.error).toBe("reasoning_budget_unsupported");
  expect(await f.scheduler.get(job.id)).toEqual(job);
  expect(await f.scheduler.listRuns()).toEqual([]);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("HTTP explicit clearing repairs a stored preference after model support changes", async () => {
  const f = await createSchedulerRuntimeFixture();
  cleanups.push(f.dispose);
  f.config.models!.providers!.local.type = "llamacpp";
  f.config.models!.profiles!["scheduled-model"].supportsThinking = true;
  const routes = new ScheduleManagementRoutes(() => f.application);
  const created = await request(routes, "POST", { ...input, reasoningPreference: {
    profileId: "scheduled-model", mode: "budget", budgetTokens: 128,
  } });
  expect(created.status).toBe(201);
  const job = created.data.job!;
  f.config.models!.providers!.local.type = "openai";
  const cleared = await request(routes, "PATCH", { reasoningPreference: null }, job.id);
  expect(cleared.status).toBe(200);
  expect(cleared.data.job?.reasoningPreference).toBeUndefined();
  expect(cleared.data.job?.revision).toBe(job.revision + 1);
  expect(f.invoke).not.toHaveBeenCalled();
});
