import type { ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { ScheduleManagementRoutes } from "../../web-ui/local-runtime/schedule-management-routes.js";
import type { JsonObject } from "../../web-ui/local-runtime/contracts.js";
import type { SchedulerJob } from "../scheduler/contracts.js";
import type { RuntimeConfig } from "../ports.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const newJobInput = {
  newConversation: true,
  title: "Daily news",
  prompt: "Collect the daily news.",
  modelProfileId: "primary",
  agentMode: "fast",
  timeZone: "UTC",
  schedule: { kind: "daily", at: "11:00" },
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "web-schedule-creation-"));
  const sessions = new SessionService({
    sessionsDir: join(directory, "sessions"),
  });
  const execute = vi.fn(async () => ({ status: "succeeded" as const }));
  const service = createSchedulerService({
    environmentId: "dev",
    store: createFileSchedulerStore(join(directory, "schedules")),
    now: () => Date.parse("2026-09-06T10:00:00Z"),
    tickIntervalMs: 1_000_000,
    executor: {
      sessionExists: async (id) => Boolean(await sessions.getSessionById(id)),
      tryReserve: () => () => undefined,
      start: execute,
    },
  });
  cleanups.push(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const routes = new ScheduleManagementRoutes(() => ({
    start: () => service.start(),
    services: {
      scheduler: service,
      sessions,
      config: {
        models: { profiles: { primary: { model: "test-model" } } },
      } as unknown as RuntimeConfig,
    },
  }));
  return { routes, service, sessions, execute };
}

async function save(routes: ScheduleManagementRoutes, body: JsonObject) {
  let status = 0;
  let raw = "";
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
    method: "POST",
    segments: ["schedules"],
    url: new URL("http://localhost/schedules?environment=dev"),
    environmentId: "dev",
    body,
    response,
  });
  return {
    status,
    data: JSON.parse(raw) as {
      job?: SchedulerJob;
      error?: string;
      message?: string;
    },
  };
}

describe("Web Job creation in dedicated conversations", () => {
  it("saves each Job in a fresh named empty conversation when none exist, without a model request", async () => {
    const f = await fixture();
    expect(await f.sessions.getAllSessions()).toEqual([]);
    const first = await save(f.routes, newJobInput);
    const second = await save(f.routes, newJobInput);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.data.job?.sessionId).not.toBe(second.data.job?.sessionId);
    for (const result of [first, second]) {
      expect(result.data.job).toMatchObject({
        environmentId: "dev",
        title: "Daily news",
        toolPermissionMode: "full_access",
      });
      expect(result.data.job).not.toHaveProperty("newConversation");
      const session = await f.sessions.getSessionById(
        result.data.job!.sessionId,
      );
      expect(session).toMatchObject({
        title: "Daily news",
        messageCount: 0,
        messages: [],
      });
      expect(session?.requests || []).toEqual([]);
    }
    expect(await f.service.list()).toHaveLength(2);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("preserves existing conversation targeting and rejects conflicting targets before mutation", async () => {
    const f = await fixture();
    await f.sessions.getOrCreateSession("existing");
    await f.sessions.updateSessionTitle("existing", "Original conversation");
    const { newConversation: _newConversation, ...fields } = newJobInput;
    const existing = await save(f.routes, { ...fields, sessionId: "existing" });
    expect(existing.status).toBe(201);
    expect(existing.data.job?.sessionId).toBe("existing");
    expect((await f.sessions.getSessionById("existing"))?.title).toBe(
      "Original conversation",
    );
    const conflict = await save(f.routes, {
      ...newJobInput,
      sessionId: "existing",
    });
    expect(conflict.status).toBe(400);
    expect(await f.service.list()).toHaveLength(1);
    expect(await f.sessions.getAllSessions()).toHaveLength(1);
  });

  it("removes only the generated empty conversation after canonical schedule validation rejects the save", async () => {
    const f = await fixture();
    await f.sessions.getOrCreateSession("existing");
    const result = await save(f.routes, {
      ...newJobInput,
      schedule: { kind: "once", at: "2026-09-01T10:00:00Z" },
    });
    expect(result.status).toBe(400);
    expect(result.data.error).toBe("scheduler_schedule_in_past");
    expect(await f.service.list()).toEqual([]);
    expect(
      (await f.sessions.getAllSessions()).map((session) => session.id),
    ).toEqual(["existing"]);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("preserves a committed Job and its conversation after an ambiguous create response", async () => {
    const f = await fixture();
    const create = f.service.create.bind(f.service);
    vi.spyOn(f.service, "create").mockImplementationOnce(async (input) => {
      await create(input);
      throw new Error("connection_closed");
    });
    const result = await save(f.routes, newJobInput);
    expect(result.status).toBe(400);
    expect(result.data.message).toContain("The conversation was kept");
    expect(await f.service.list()).toHaveLength(1);
    expect(await f.sessions.getAllSessions()).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("keeps the conversation when a failed lookup cannot prove that no Job was saved", async () => {
    const f = await fixture();
    vi.spyOn(f.service, "create").mockRejectedValueOnce(
      new Error("connection_closed"),
    );
    vi.spyOn(f.service, "list").mockRejectedValueOnce(
      new Error("connection_closed"),
    );
    const remove = vi.spyOn(f.sessions, "deleteSession");
    const result = await save(f.routes, newJobInput);
    expect(result.status).toBe(400);
    expect(result.data.message).toContain("check Jobs before saving again");
    expect(remove).not.toHaveBeenCalled();
    expect(await f.sessions.getAllSessions()).toHaveLength(1);
  });

  it("preserves new conversation content even when no Job was saved", async () => {
    const f = await fixture();
    vi.spyOn(f.service, "create").mockImplementationOnce(async (input) => {
      await f.sessions.appendMessage(input.sessionId, "user", "Keep this note.");
      throw new Error("scheduler_stopped");
    });
    const remove = vi.spyOn(f.sessions, "deleteSession");
    const result = await save(f.routes, newJobInput);
    expect(result.status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
    const [session] = await f.sessions.getAllSessions();
    expect(session.messages[0].content).toBe("Keep this note.");
  });
});
