import { describe, expect, test, vi } from "vitest";
import type { ToolExecutionContext } from "../../capabilities/tool-types.js";
import { createSchedulingToolModule } from "../capabilities/scheduling/tool-module.js";
import type { RuntimeConfig } from "../ports.js";
import type {
  SchedulerJob,
  SchedulerRun,
  SchedulerService,
} from "../scheduler/contracts.js";

function createFixture() {
  const config: RuntimeConfig = {
    runtimeId: "test",
    agentBridgeUrl: "ws://test",
    modelGatewayUrl: "http://test",
    requestRunner: { configPath: "/unused/request-runner.json" },
    paths: {
      rootDir: "/unused",
      runtimeDir: "/unused/runtime",
      agentWorkDir: "/unused/work",
      sessionsDir: "/unused/sessions",
      attachmentsDir: "/unused/attachments",
      workspaceDir: "/unused/workspace",
      sharedDir: "/unused/shared",
      compiledDir: "/unused/compiled",
      traceFile: "/unused/trace.jsonl",
    },
    models: {
      defaults: { profileId: "default" },
      providers: { ollama: { type: "ollama" } },
      profiles: {
        default: {
          provider: "ollama",
          model: "default-model",
          contextWindowTokens: 8000,
        },
        selected: {
          provider: "ollama",
          model: "selected-model",
          contextWindowTokens: 8000,
        },
      },
    },
  };
  const job: SchedulerJob = {
    id: "job",
    environmentId: "environment",
    sessionId: "current-session",
    title: "Reminder",
    prompt: "Future active request",
    modelProfileId: "selected",
    agentMode: "deep",
    toolPermissionMode: "full_access",
    timeZone: "Asia/Jerusalem",
    schedule: { kind: "daily", at: "09:00" },
    state: "active",
    revision: 1,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    nextRunAt: "2026-09-06T06:00:00.000Z",
  };
  const run: SchedulerRun = {
    id: "run",
    jobId: job.id,
    environmentId: job.environmentId,
    sessionId: job.sessionId,
    requestId: "request",
    title: job.title,
    prompt: job.prompt,
    modelProfileId: job.modelProfileId,
    agentMode: job.agentMode,
    timeZone: job.timeZone,
    jobRevision: job.revision,
    scheduledAt: job.nextRunAt!,
    trigger: "manual",
    status: "pending",
  };
  const service = {
    start: vi.fn<SchedulerService["start"]>().mockResolvedValue(),
    stop: vi.fn<SchedulerService["stop"]>().mockResolvedValue(),
    tick: vi.fn<SchedulerService["tick"]>().mockResolvedValue(),
    create: vi.fn<SchedulerService["create"]>().mockResolvedValue(job),
    list: vi.fn<SchedulerService["list"]>().mockResolvedValue([job]),
    get: vi.fn<SchedulerService["get"]>().mockResolvedValue(job),
    update: vi.fn<SchedulerService["update"]>().mockResolvedValue(job),
    pause: vi.fn<SchedulerService["pause"]>().mockResolvedValue(job),
    resume: vi.fn<SchedulerService["resume"]>().mockResolvedValue(job),
    cancel: vi.fn<SchedulerService["cancel"]>().mockResolvedValue(job),
    runNow: vi.fn<SchedulerService["runNow"]>().mockResolvedValue(run),
    deleteSession: vi
      .fn<SchedulerService["deleteSession"]>()
      .mockResolvedValue(),
    listRuns: vi.fn<SchedulerService["listRuns"]>().mockResolvedValue([run]),
  } satisfies SchedulerService;
  const ready = vi.fn(async () => undefined);
  const context: ToolExecutionContext = {
    sharedState: {
      currentSessionId: "current-session",
      requestContext: {
        agentMode: "deep",
        toolPermissionMode: "ask",
        modelPreference: { profileId: "selected", scope: "all" },
      },
    },
  };
  const module = createSchedulingToolModule(service, config, ready);
  return { config, job, run, service, ready, context, module };
}

const createParams = {
  action: "create",
  title: "Reminder",
  prompt: "Future active request",
  scheduleKind: "weekly",
  at: "09:00",
  weekdays: [3, 6],
  timeZone: "Asia/Jerusalem",
};

describe("native scheduling tool binding", () => {
  test("binds creation to the current request session, selected model and mode without accepting a permission override", async () => {
    const { module, service, context, ready } = createFixture();
    const result = await module.implementation(
      {
        ...createParams,
        sessionId: "foreign-session",
        modelProfileId: "foreign-model",
        agentMode: "fast",
        toolPermissionMode: "ask",
      },
      context,
    );
    expect(result.ok).toBe(true);
    expect(ready).toHaveBeenCalledOnce();
    expect(service.create).toHaveBeenCalledExactlyOnceWith({
      sessionId: "current-session",
      title: "Reminder",
      prompt: "Future active request",
      modelProfileId: "selected",
      agentMode: "deep",
      timeZone: "Asia/Jerusalem",
      schedule: { kind: "weekly", at: "09:00", weekdays: [3, 6] },
    });
    expect(service.create.mock.calls[0][0]).not.toHaveProperty(
      "toolPermissionMode",
    );
    for (const operation of module.normalInvocation.operations) {
      expect(operation.input.properties).not.toHaveProperty(
        "toolPermissionMode",
      );
      expect(operation.input.properties).not.toHaveProperty("sessionId");
    }
    expect(result.data).toMatchObject({
      mutationEvidence: true,
      currentStateEvidence: true,
    });
  });

  test("uses the effective default model when runtime configuration overrides the client preference", async () => {
    const { config, service, context, ready } = createFixture();
    config.models!.defaults!.overrideClientPreference = true;
    const module = createSchedulingToolModule(service, config, ready);
    expect((await module.implementation(createParams, context)).ok).toBe(true);
    expect(service.create.mock.calls[0][0].modelProfileId).toBe("default");
  });

  test.each(["once", "daily", "weekly", "monthly"])(
    "requires an exact time before creating a %s schedule",
    async (scheduleKind) => {
      const { module, service, context } = createFixture();
      const result = await module.implementation(
        { ...createParams, scheduleKind, at: undefined },
        context,
      );
      expect(result).toMatchObject({
        ok: false,
        error: "schedule_exact_time_required",
      });
      expect(service.create).not.toHaveBeenCalled();
    },
  );

  test.each(["daily", "weekly", "monthly"])(
    "requires an explicit time zone before creating a %s schedule",
    async (scheduleKind) => {
      const { module, service, context } = createFixture();
      for (const timeZone of [undefined, "", "   "]) {
        const result = await module.implementation(
          { ...createParams, scheduleKind, dayOfMonth: 5, timeZone },
          context,
        );
        expect(result).toMatchObject({
          ok: false,
          error: "schedule_time_zone_required",
        });
        expect(service.create).not.toHaveBeenCalled();
      }
    },
  );

  test.each([
    { scheduleKind: "timer", delayMs: 60_000 },
    { scheduleKind: "once", at: "2026-09-07T09:00:00+03:00" },
    { scheduleKind: "interval", everyMs: 60_000 },
  ])("allows $scheduleKind without a calendar time zone", async (timing) => {
    const { module, service, context } = createFixture();
    const result = await module.implementation(
      { ...createParams, ...timing, timeZone: undefined },
      context,
    );
    expect(result.ok).toBe(true);
    expect(service.create).toHaveBeenCalledOnce();
    expect(service.create.mock.calls[0][0]).toMatchObject({
      modelProfileId: "selected",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      schedule: { kind: timing.scheduleKind },
    });
  });

  test.each(["get", "update", "pause", "resume", "cancel", "run_now"])(
    "does not allow %s to access another conversation's Job",
    async (action) => {
      const { module, service, context, job } = createFixture();
      service.get.mockResolvedValue({ ...job, sessionId: "another-session" });
      const result = await module.implementation(
        { action, jobId: "foreign-job", title: "change" },
        context,
      );
      expect(result).toMatchObject({
        ok: false,
        error: "schedule_job_not_found",
      });
      expect(service.update).not.toHaveBeenCalled();
      expect(service.pause).not.toHaveBeenCalled();
      expect(service.resume).not.toHaveBeenCalled();
      expect(service.cancel).not.toHaveBeenCalled();
      expect(service.runNow).not.toHaveBeenCalled();
      expect(service.listRuns).not.toHaveBeenCalled();
    },
  );

  test("listing is session-bound passive data without exposing future prompts or running jobs", async () => {
    const { module, service, context, job } = createFixture();
    service.list.mockResolvedValue(
      Array.from({ length: 103 }, (_, index) => ({
        ...job,
        id: `job-${index}`,
      })),
    );
    const result = await module.implementation(
      { action: "list", sessionId: "foreign-session" },
      context,
    );
    expect(result.ok).toBe(true);
    expect(service.list).toHaveBeenCalledExactlyOnceWith({
      sessionId: "current-session",
    });
    const output = JSON.parse(result.output);
    expect(output.jobs).toHaveLength(100);
    expect(output.omittedCount).toBe(3);
    expect(output.jobs[0]).not.toHaveProperty("prompt");
    expect(result.data).toMatchObject({
      mutationEvidence: false,
      currentStateEvidence: true,
    });
    expect(service.runNow).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
    expect(service.tick).not.toHaveBeenCalled();
    expect(
      module.normalInvocation.operations.find(
        (operation) => operation.operationId === "list",
      )?.effect,
    ).toBe("read_only");
  });

  test("details expose the exact owned Job and its run history as passive data", async () => {
    const { module, service, context, job, run } = createFixture();
    const older = { ...run, id: "older-run", scheduledAt: job.createdAt };
    const newestFirst = [run, older];
    service.listRuns.mockResolvedValue(newestFirst);
    const result = await module.implementation(
      { action: "get", jobId: "job" },
      context,
    );
    expect(JSON.parse(result.output)).toEqual({ job, runs: [older, run] });
    expect(newestFirst).toEqual([run, older]);
    expect(service.listRuns).toHaveBeenCalledExactlyOnceWith("job", {
      limit: 20,
    });
    expect(result.data?.mutationEvidence).toBe(false);
    expect(service.runNow).not.toHaveBeenCalled();
  });

  test.each(["pause", "resume", "cancel", "run_now"])(
    "dispatches %s only after checking the owned Job",
    async (action) => {
      const { module, service, context } = createFixture();
      const result = await module.implementation(
        { action, jobId: "job" },
        context,
      );
      expect(result.ok).toBe(true);
      expect(service.get).toHaveBeenCalledExactlyOnceWith("job");
      const method =
        action === "run_now"
          ? service.runNow
          : service[action as "pause" | "resume" | "cancel"];
      expect(method).toHaveBeenCalledExactlyOnceWith("job");
      expect(result.data?.mutationEvidence).toBe(true);
    },
  );

  test("edits only supplied Job settings and cannot alter session or FULL permissions", async () => {
    const { module, service, context } = createFixture();
    const result = await module.implementation(
      {
        action: "update",
        jobId: "job",
        title: "Changed",
        modelProfileId: "default",
        agentMode: "fast",
        sessionId: "foreign",
        toolPermissionMode: "ask",
      },
      context,
    );
    expect(result.ok).toBe(true);
    expect(service.update).toHaveBeenCalledExactlyOnceWith("job", {
      title: "Changed",
      modelProfileId: "default",
      agentMode: "fast",
    });
  });

  test.each([
    { modelProfileId: "missing", overrideClientPreference: false },
    { modelProfileId: "selected", overrideClientPreference: true },
  ])(
    "rejects an unavailable model before updating any Job field: $modelProfileId, override=$overrideClientPreference",
    async ({ modelProfileId, overrideClientPreference }) => {
      const { module, service, context, config } = createFixture();
      config.models!.defaults!.overrideClientPreference =
        overrideClientPreference;
      const result = await module.implementation(
        {
          action: "update",
          jobId: "job",
          title: "Must not persist",
          modelProfileId,
        },
        context,
      );
      expect(result).toMatchObject({
        ok: false,
        error: "scheduler_model_unavailable",
      });
      expect(service.update).not.toHaveBeenCalled();
      expect(service.create).not.toHaveBeenCalled();
    },
  );

  test.each([
    { label: "title", patch: { title: "Changed" } },
    { label: "recurrence", patch: { scheduleKind: "daily", at: "10:00" } },
  ])(
    "retains the saved time zone and model when editing $label",
    async ({ patch }) => {
      const { module, service, context } = createFixture();
      const result = await module.implementation(
        { action: "update", jobId: "job", ...patch },
        context,
      );
      expect(result.ok).toBe(true);
      expect(service.update).toHaveBeenCalledOnce();
      expect(service.update.mock.calls[0][1]).not.toHaveProperty("timeZone");
      expect(service.update.mock.calls[0][1]).not.toHaveProperty("modelProfileId");
    },
  );

  test("missing context or cancelled request cannot create a job", async () => {
    const { module, service, context } = createFixture();
    expect(await module.implementation(createParams)).toMatchObject({
      ok: false,
      error: "schedule_session_required",
    });
    const controller = new AbortController();
    controller.abort(new Error("request_cancelled"));
    expect(
      await module.implementation(createParams, {
        ...context,
        abortSignal: controller.signal,
      }),
    ).toMatchObject({ ok: false, error: "request_cancelled" });
    expect(service.create).not.toHaveBeenCalled();
  });

  test("waits for service readiness before creating and surfaces initialization failure", async () => {
    const { config, service, context } = createFixture();
    let fail!: (reason: Error) => void;
    const ready = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const module = createSchedulingToolModule(service, config, () => ready);
    const creation = module.implementation(createParams, context);
    expect(service.create).not.toHaveBeenCalled();
    fail(new Error("scheduler_unavailable"));
    expect(await creation).toMatchObject({
      ok: false,
      error: "scheduler_unavailable",
    });
    expect(service.create).not.toHaveBeenCalled();
  });
});
