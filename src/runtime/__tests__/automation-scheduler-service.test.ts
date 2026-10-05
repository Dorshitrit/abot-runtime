import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SessionRequestAdmission } from "../request/session-admission.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";
import { isAutomationSchedulerRun } from "../scheduler/scheduler-target.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import type {
  SchedulerAutomationExecutor,
  SchedulerAutomationRunOutcome,
  SchedulerExecutor,
  SchedulerService,
} from "../scheduler/contracts.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "automation-scheduler-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = createFileSchedulerStore(directory);
  const admission = new SessionRequestAdmission(() => false);
  let now = Date.parse("2026-09-29T08:00:00.000Z");
  const requestStart = vi.fn<SchedulerExecutor["start"]>();
  const request: SchedulerExecutor = {
    sessionExists: async () => true,
    tryReserve: () => () => undefined,
    start: requestStart,
  };
  const prepare = vi.fn<SchedulerAutomationExecutor["prepare"]>(
    async (job) => ({
      kind: "ready",
      inputIds: [],
      commit: (state, runId) => {
        state.executions.push({
          id: runId,
          automationId: job.target.automationId,
          definitionRevision: job.target.definitionRevision,
          revision: 1,
          inputIds: [],
          nodes: [],
        });
      },
    }),
  );
  const start = vi.fn<SchedulerAutomationExecutor["start"]>(
    (_job, run) => ({
      outcome: Promise.resolve({
        status: "succeeded",
        reportRef: `report-${run.id}`,
      }),
      resourcesSettled: Promise.resolve(),
    }),
  );
  const prepareReplay = vi.fn<NonNullable<SchedulerAutomationExecutor["prepareReplay"]>>(
    async (job, previous) => ({
      kind: "ready",
      inputIds: [],
      commit: (state, runId) => {
        state.executions.push({
          id: runId,
          automationId: job.target.automationId,
          definitionRevision: previous.target.definitionRevision,
          revision: 1,
          inputIds: [],
          nodes: [],
        });
      },
    }),
  );
  const stop = vi.fn<SchedulerAutomationExecutor["stop"]>();
  const automation: SchedulerAutomationExecutor = {
    prepare,
    prepareReplay,
    start,
    tryReserve: (automationId) => admission.tryReserveAutomation(automationId),
    stop,
    cancelPending: (run, state) => {
      const index = state.executions.findIndex((item) => item.id === run.id);
      state.executions[index] = {
        ...state.executions[index],
        revision: state.executions[index].revision + 1,
        reportRef: `derived:${run.id}`,
      };
    },
    settle: (run, state, outcome) => {
      const index = state.executions.findIndex((item) => item.id === run.id);
      state.executions[index] = {
        ...state.executions[index],
        revision: state.executions[index].revision + 1,
        reportRef: outcome.reportRef,
      };
    },
    recover: (scheduler, state, runIds) => {
      for (const runId of runIds) {
        const run = scheduler.runs.find((item) => item.id === runId);
        if (!run || !isAutomationSchedulerRun(run)) continue;
        const reportRef = `recovery-report-${runId}`;
        run.reportRef = reportRef;
        const index = state.executions.findIndex((item) => item.id === runId);
        if (index >= 0) {
          state.executions[index] = {
            ...state.executions[index],
            revision: state.executions[index].revision + 1,
            reportRef,
          };
          continue;
        }
        state.executions.push({
          id: runId,
          automationId: run.target.automationId,
          definitionRevision: run.target.definitionRevision,
          revision: 1,
          inputIds: [],
          nodes: [],
          reportRef,
        });
      }
    },
  };
  const createService = () =>
    createSchedulerService({
      environmentId: "dev",
      store,
      executor: request,
      automationExecutor: automation,
      now: () => now,
      tickIntervalMs: 1_000_000,
    });
  const service = createService();
  cleanups.push(() => service.stop());
  await service.start();
  const createJob = (schedule: { kind: "manual" } | { kind: "interval"; everyMs: number }) =>
    service.createAutomationJob({
      automationId: "automation-1",
      definitionRevision: 1,
      title: "Check inputs",
      timeZone: "UTC",
      schedule,
    });
  return {
    store,
    service,
    createService,
    createJob,
    prepare,
    prepareReplay,
    start,
    stop,
    requestStart,
    admission,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function automationRuns(f: Awaited<ReturnType<typeof fixture>>) {
  return (await f.store.readRuns?.(undefined, undefined, "automation")) ?? [];
}

async function createBudgetJob(
  f: Awaited<ReturnType<typeof fixture>>,
  schedule: { kind: "manual" } | { kind: "interval"; everyMs: number },
  maxRunsPerDay: number,
) {
  return f.service.createAutomationJob({
    automationId: "automation-1", definitionRevision: 1,
    title: "Daily budget", timeZone: "UTC", schedule,
  }, (state) => {
    state.definitions.push({
      id: "definition-1", automationId: "automation-1", revision: 1,
      publishedAt: "2026-09-29T08:00:00.000Z",
      definition: {
        schemaVersion: 1, automationId: "automation-1", revision: 1,
        title: "Daily budget", objective: "Budget admission",
        trigger: { kind: "manual" }, inputs: {},
        body: { kind: "sequence", id: "root", children: [] },
        limits: { ...DEFAULT_AUTOMATION_LIMITS, maxRunsPerDay },
      },
    });
  });
}

test("manual tool-only automation has no synthetic session/model and shares idle admission", async () => {
  const f = await fixture();
  const pending = deferred<SchedulerAutomationRunOutcome>();
  f.start.mockReturnValue({
    outcome: pending.promise,
    resourcesSettled: pending.promise.then(() => undefined),
  });
  const job = await f.createJob({ kind: "manual" });
  expect(job.state).toBe("paused");
  expect(job.nextRunAt).toBeNull();
  const run = await f.service.runNowAutomation(job.id);
  expect("sessionId" in run).toBe(false);
  expect("modelProfileId" in run).toBe(false);
  await f.service.tick();
  expect(f.requestStart).not.toHaveBeenCalled();
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.admission.isIdle()).toBe(false);
  pending.resolve({ status: "succeeded", reportRef: `report-${run.id}` });
  await vi.waitFor(async () =>
    expect((await automationRuns(f))[0]).toMatchObject({
      id: run.id,
      status: "succeeded",
      reportRef: `report-${run.id}`,
    }),
  );
  expect(f.admission.isIdle()).toBe(true);
});

test("scheduled discovery with no eligible input creates no Run; persistent failure pauses once", async () => {
  const f = await fixture();
  const job = await f.createJob({ kind: "interval", everyMs: 60_000 });
  await f.service.resumeAutomationJob(job.id);
  f.prepare.mockResolvedValueOnce({ kind: "no_input" });
  f.advance(60_000);
  await f.service.tick();
  expect(await automationRuns(f)).toEqual([]);
  expect(f.start).not.toHaveBeenCalled();
  f.prepare.mockImplementationOnce(async (candidate) => ({
    kind: "failed",
    error: "automation_source_unavailable",
    commit: (state, runId) => {
      state.executions.push({
        id: runId,
        automationId: candidate.target.automationId,
        definitionRevision: candidate.target.definitionRevision,
        revision: 1,
        inputIds: [],
        nodes: [],
        reportRef: `failed-report-${runId}`,
      });
    },
  }));
  f.advance(60_000);
  await f.service.tick();
  const runs = await automationRuns(f);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    status: "failed",
    error: "automation_source_unavailable",
  });
  expect((await f.store.read()).jobs[0].state).toBe("paused");
  f.advance(600_000);
  await f.service.tick();
  expect(await automationRuns(f)).toHaveLength(1);
  expect(f.start).not.toHaveBeenCalled();
});

test("startup marks pending automation missed with a report and never executes it", async () => {
  const f = await fixture();
  const job = await f.createJob({ kind: "manual" });
  const run = await f.service.runNowAutomation(job.id);
  await f.service.stop();
  const resumed: SchedulerService = f.createService();
  cleanups.push(() => resumed.stop());
  await resumed.start();
  expect((await automationRuns(f))[0]).toMatchObject({
    id: run.id,
    status: "missed",
    reportRef: `recovery-report-${run.id}`,
  });
  await resumed.tick();
  expect(f.start).not.toHaveBeenCalled();
});

test("startup interrupts a running automation without replaying its executor", async () => {
  const f = await fixture();
  const unresolved = deferred<SchedulerAutomationRunOutcome>();
  f.start.mockReturnValue({
    outcome: unresolved.promise,
    resourcesSettled: unresolved.promise.then(() => undefined),
  });
  const job = await f.createJob({ kind: "manual" });
  const run = await f.service.runNowAutomation(job.id);
  await f.service.tick();
  expect(f.start).toHaveBeenCalledOnce();
  await f.service.stop();
  const resumed = f.createService();
  cleanups.push(() => resumed.stop());
  await resumed.start();
  expect((await automationRuns(f))[0]).toMatchObject({
    id: run.id,
    status: "interrupted",
    reportRef: `recovery-report-${run.id}`,
  });
  await resumed.tick();
  expect(f.start).toHaveBeenCalledOnce();
});

test("pausing cancels only a pending automation with an atomic derived report", async () => {
  const f = await fixture();
  const job = await f.createJob({ kind: "manual" });
  const run = await f.service.runNowAutomation(job.id);
  await f.service.pauseAutomationJob(job.id);
  expect((await automationRuns(f))[0]).toMatchObject({
    id: run.id,
    status: "cancelled",
    reportRef: `derived:${run.id}`,
  });
  const automations = await f.store.readAutomations?.();
  expect(automations?.executions[0]).toMatchObject({
    id: run.id,
    revision: 2,
    reportRef: `derived:${run.id}`,
  });
  await f.service.tick();
  expect(f.start).not.toHaveBeenCalled();
});

test("republishing cancels pending revision but preserves a running snapshot", async () => {
  const f = await fixture();
  const pending = deferred<SchedulerAutomationRunOutcome>();
  f.start.mockReturnValue({
    outcome: pending.promise,
    resourcesSettled: pending.promise.then(() => undefined),
  });
  const job = await f.createJob({ kind: "manual" });
  const first = await f.service.runNowAutomation(job.id);
  await f.service.updateAutomationJob(job.id, { definitionRevision: 2 });
  expect((await automationRuns(f))[0]).toMatchObject({
    id: first.id,
    status: "cancelled",
    reportRef: `derived:${first.id}`,
  });
  const second = await f.service.runNowAutomation(job.id);
  await f.service.tick();
  expect(f.start).toHaveBeenCalledWith(
    expect.objectContaining({ target: { kind: "automation", automationId: "automation-1", definitionRevision: 2 } }),
    expect.objectContaining({ id: second.id }),
  );
  await f.service.updateAutomationJob(job.id, { definitionRevision: 3 });
  expect((await automationRuns(f)).find((run) => run.id === second.id)).toMatchObject({
    status: "running",
    target: { kind: "automation", automationId: "automation-1", definitionRevision: 2 },
  });
  pending.resolve({ status: "succeeded", reportRef: `report-${second.id}` });
  await vi.waitFor(async () =>
    expect((await automationRuns(f)).find((run) => run.id === second.id)).toMatchObject({
      status: "succeeded",
    }),
  );
});

test("manual idempotency returns the committed Run and conflicts after publication changes", async () => {
  const f = await fixture();
  const job = await f.createJob({ kind: "manual" });
  const first = await f.service.runNowAutomation(job.id, { idempotencyKey: "client-request-1" });
  await f.service.stopAutomationRun(first.id);
  const repeated = await f.service.runNowAutomation(job.id, { idempotencyKey: "client-request-1" });
  expect(repeated.id).toBe(first.id);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(await f.service.getAutomationRun(first.id)).toMatchObject({
    id: first.id,
    status: "cancelled",
    idempotencyKey: "client-request-1",
  });
  expect(await f.service.listAutomationRuns("automation-1", { limit: 1 })).toHaveLength(1);
  await f.service.updateAutomationJob(job.id, { definitionRevision: 2 });
  await expect(
    f.service.runNowAutomation(job.id, { idempotencyKey: "client-request-1" }),
  ).rejects.toThrow("automation_idempotency_conflict");
});

test("stop commits intent, but terminal report does not release unsettled resources", async () => {
  const f = await fixture();
  const outcome = deferred<SchedulerAutomationRunOutcome>();
  const resources = deferred<void>();
  f.start.mockReturnValue({
    outcome: outcome.promise,
    resourcesSettled: resources.promise,
  });
  const job = await f.createJob({ kind: "manual" });
  const run = await f.service.runNowAutomation(job.id);
  await f.service.tick();
  const stopping = await f.service.stopAutomationRun(run.id);
  expect(stopping.status).toBe("stopping");
  expect(f.stop).toHaveBeenCalledWith(run.id);
  expect((await f.store.readAutomations?.())?.executions[0]).toMatchObject({
    id: run.id,
    revision: 2,
    stopRequestedAt: expect.any(String),
  });
  outcome.resolve({ status: "cancelled", reportRef: `report-${run.id}` });
  await vi.waitFor(async () =>
    expect(await f.service.getAutomationRun(run.id)).toMatchObject({
      status: "cancelled",
      reportRef: `report-${run.id}`,
    }),
  );
  expect(f.admission.isIdle()).toBe(false);
  resources.resolve(undefined);
  await vi.waitFor(() => expect(f.admission.isIdle()).toBe(true));
});

test("manual admission enforces the local daily run budget across terminal history", async () => {
  const f = await fixture();
  const job = await createBudgetJob(f, { kind: "manual" }, 1);
  const first = await f.service.runNowAutomation(job.id);
  await f.service.stopAutomationRun(first.id);
  await expect(f.service.runNowAutomation(job.id))
    .rejects.toThrow("automation_budget_exhausted");
  expect(f.prepare).toHaveBeenCalledTimes(2);
  expect(await automationRuns(f)).toHaveLength(1);
  f.advance(24 * 60 * 60_000);
  const nextDay = await f.service.runNowAutomation(job.id);
  expect(nextDay.id).not.toBe(first.id);
});

test("no-input ticks consume no budget and scheduled work skips after the limit", async () => {
  const f = await fixture();
  const job = await createBudgetJob(f, { kind: "interval", everyMs: 60_000 }, 1);
  await f.service.resumeAutomationJob(job.id);
  f.prepare.mockResolvedValueOnce({ kind: "no_input" });
  f.advance(60_000);
  await f.service.tick();
  expect(await automationRuns(f)).toHaveLength(0);
  f.advance(60_000);
  await f.service.tick();
  expect(await automationRuns(f)).toHaveLength(1);
  f.advance(60_000);
  await f.service.tick();
  expect(await automationRuns(f)).toHaveLength(1);
  expect(f.prepare).toHaveBeenCalledTimes(3);
});

test("a delayed scheduled occurrence consumes budget on its actual admission day", async () => {
  const f = await fixture();
  const job = await createBudgetJob(f, { kind: "interval", everyMs: 60_000 }, 1);
  await f.service.resumeAutomationJob(job.id);
  f.advance(16 * 60 * 60_000 + 60_000); // Sep 30 00:01 UTC; due was Sep 29 08:01.
  await f.service.tick();
  const first = (await automationRuns(f))[0];
  expect(first).toMatchObject({
    scheduledAt: "2026-09-29T08:01:00.000Z",
    admittedAt: "2026-09-30T00:01:00.000Z",
  });
  f.advance(60_000);
  await f.service.tick();
  expect(await automationRuns(f)).toHaveLength(1);
});

test("confirmed rerun creates a new Run from the historical revision and is idempotent", async () => {
  const f = await fixture();
  const job = await f.createJob({ kind: "manual" });
  const previous = await f.service.runNowAutomation(job.id);
  await f.service.stopAutomationRun(previous.id);
  await f.service.updateAutomationJob(job.id, { definitionRevision: 2 });
  const validateAdmission = vi.fn();
  const preflight = vi.fn(async () => undefined);
  const options = {
    idempotencyKey: "rerun-request-1",
    confirmed: true as const,
    preflight,
    validateAdmission,
  };
  const rerun = await f.service.rerunAutomationRun(previous.id, options);
  expect(rerun).toMatchObject({
    status: "pending", replayOf: previous.id,
    target: { kind: "automation", automationId: "automation-1", definitionRevision: 1 },
  });
  expect(rerun.id).not.toBe(previous.id);
  expect(validateAdmission).toHaveBeenCalledOnce();
  expect(preflight).toHaveBeenCalledOnce();
  expect(f.prepareReplay).toHaveBeenCalledWith(
    expect.objectContaining({ target: expect.objectContaining({ definitionRevision: 1 }) }),
    expect.objectContaining({ id: previous.id }),
    expect.any(String),
  );
  const repeated = await f.service.rerunAutomationRun(previous.id, options);
  expect(repeated.id).toBe(rerun.id);
  expect(f.prepareReplay).toHaveBeenCalledOnce();
  expect(preflight).toHaveBeenCalledOnce();
  await expect(f.service.runNowAutomation(job.id, {
    idempotencyKey: "rerun-request-1",
  })).rejects.toThrow("automation_idempotency_conflict");
  expect((await automationRuns(f)).find((item) => item.id === previous.id))
    .toMatchObject({ status: "cancelled", reportRef: `derived:${previous.id}` });
});

test("rerun denies a revoked current admission before reserving old inputs", async () => {
  const f = await fixture();
  const job = await f.createJob({ kind: "manual" });
  const previous = await f.service.runNowAutomation(job.id);
  await f.service.stopAutomationRun(previous.id);
  await expect(f.service.rerunAutomationRun(previous.id, {
    idempotencyKey: "rerun-revoked",
    confirmed: true,
    preflight: async () => { throw new Error("automation_grant_revoked"); },
    validateAdmission: () => undefined,
  })).rejects.toThrow("automation_grant_revoked");
  expect(f.prepareReplay).not.toHaveBeenCalled();
  expect(await automationRuns(f)).toHaveLength(1);
});
