import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ToolUnderlyingSettlement } from "../../capabilities/tool-types.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import { createAutomationNodeTransactions } from "../automations/node-transactions.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import { createAutomationPersistence } from "../automations/persistence.js";
import { createAutomationResultStore } from "../automations/result-store.js";
import { createAutomationRuntimeExecutor } from "../automations/runtime-executor.js";
import { createAutomationToolLifetimes } from "../automations/tool-lifetimes.js";
import type { RuntimeConfig, RuntimePaths } from "../ports.js";
import { SessionRequestAdmission } from "../request/session-admission.js";
import type {
  SchedulerAutomationRunOutcome,
  SchedulerExecutor,
} from "../scheduler/contracts.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import { createSchedulerService } from "../scheduler/scheduler-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(maxRunDurationMs = DEFAULT_AUTOMATION_LIMITS.maxRunDurationMs) {
  const root = await mkdtemp(join(tmpdir(), "automation-rejection-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths: RuntimePaths = {
    rootDir: root, runtimeDir: join(root, "runtime"),
    agentWorkDir: join(root, "work"), sessionsDir: join(root, "sessions"),
    attachmentsDir: join(root, "attachments"), workspaceDir: join(root, "workspace"),
    sharedDir: join(root, "shared"), compiledDir: join(root, "compiled"),
    traceFile: join(root, "trace.jsonl"),
  };
  const now = () => Date.parse("2026-09-29T10:00:00Z");
  const store = createFileSchedulerStore(paths.runtimeDir);
  const persistence = createAutomationPersistence(store);
  const admission = new SessionRequestAdmission(() => false);
  const lifetimes = createAutomationToolLifetimes();
  const attachments = createFileAttachmentStore({ attachmentsDir: paths.attachmentsDir });
  const execute = vi.fn<Parameters<typeof createAutomationRuntimeExecutor>[0]["execute"]>(
    async (_job, run) => ({ status: "succeeded", reportRef: `derived:${run.id}` }),
  );
  const runtime = createAutomationRuntimeExecutor({
    config: { runtimeId: "dev", paths } as RuntimeConfig,
    persistence,
    attachments,
    results: createAutomationResultStore(paths.runtimeDir),
    toolLifetimes: lifetimes,
    execute,
    now,
  });
  const onError = vi.fn();
  const service = createSchedulerService({
    environmentId: "dev", store, now, tickIntervalMs: 1_000_000, onError,
    executor: {
      sessionExists: async () => true,
      tryReserve: () => () => undefined,
      start: vi.fn<SchedulerExecutor["start"]>(),
    },
    automationExecutor: {
      ...runtime,
      tryReserve: (id) => admission.tryReserveAutomation(id),
    },
  });
  cleanups.push(() => service.stop());
  await service.start();
  const job = await service.createAutomationJob({
    automationId: "automation-1", definitionRevision: 1,
    title: "Rejection handling", timeZone: "UTC", schedule: { kind: "manual" },
  }, (state) => {
    state.definitions.push({
      id: "definition-1", automationId: "automation-1", revision: 1,
      publishedAt: new Date(now()).toISOString(),
      definition: {
        schemaVersion: 1, automationId: "automation-1", revision: 1,
        title: "Rejection handling", objective: "Persist terminal failure",
        trigger: { kind: "manual" }, inputs: {},
        body: { kind: "sequence", id: "root", children: [] },
        limits: { ...DEFAULT_AUTOMATION_LIMITS, maxRunDurationMs, stopReportDeadlineMs: 10 },
      },
    });
  });
  // Keep failure injection scoped to the execution read, not retention maintenance.
  await runtime.maintainRetention!(now());
  return { service, job, persistence, admission, lifetimes, attachments, execute, onError };
}

async function waitForOutcome(
  f: Awaited<ReturnType<typeof fixture>>,
  runId: string,
  status: SchedulerAutomationRunOutcome["status"],
) {
  await vi.waitFor(async () => {
    expect((await f.service.getAutomationRun(runId))?.status).toBe(status);
  });
  return f.service.getAutomationRun(runId);
}

test.each([
  { kind: "synchronous throw", reject: (): never => { throw new Error("execute_failed"); } },
  { kind: "asynchronous rejection", reject: () => Promise.reject(new Error("execute_failed")) },
  { kind: "non-Error rejection", reject: () => Promise.reject("execute_failed") },
])("$kind commits one failed report and permits the next run", async ({ reject }) => {
  const f = await fixture();
  f.execute.mockImplementationOnce(reject);
  const run = await f.service.runNowAutomation(f.job.id);
  await f.service.tick();
  const completed = await waitForOutcome(f, run.id, "failed");
  expect(completed).toMatchObject({ error: "execute_failed", reportRef: `derived:${run.id}` });
  const execution = (await f.persistence.read()).executions.find((item) => item.id === run.id);
  expect(execution).toMatchObject({ reportRef: `derived:${run.id}`, terminalAt: completed!.finishedAt });
  await vi.waitFor(() => expect(f.admission.isIdle()).toBe(true));

  await f.service.tick();
  await f.service.tick();
  expect(f.execute).toHaveBeenCalledOnce();
  expect((await f.persistence.read()).executions.find((item) => item.id === run.id)?.revision)
    .toBe(execution!.revision);
  expect(f.onError).not.toHaveBeenCalled();

  const next = await f.service.runNowAutomation(f.job.id);
  await f.service.tick();
  await waitForOutcome(f, next.id, "succeeded");
  expect(f.execute).toHaveBeenCalledTimes(2);
});

test("a rejected execution read settles with a report without dispatching the graph", async () => {
  const f = await fixture();
  const run = await f.service.runNowAutomation(f.job.id);
  vi.spyOn(f.persistence, "read").mockRejectedValueOnce(new Error("execution_read_failed"));
  await f.service.tick();
  expect(await waitForOutcome(f, run.id, "failed")).toMatchObject({
    error: "execution_read_failed", reportRef: `derived:${run.id}`,
  });
  await f.service.tick();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(f.admission.isIdle()).toBe(true));
});

test("rejection holds uncertain inputs and admission until underlying effects settle", async () => {
  const f = await fixture();
  const effect = deferred<ToolUnderlyingSettlement>();
  f.execute.mockImplementationOnce(async (_job, run) => {
    const attachment = await f.attachments.saveAttachment({
      sessionId: run.id, requestId: "input-1", kind: "file", mimeType: "text/plain",
      bytes: Buffer.from("input"), name: "file.txt",
    });
    await f.persistence.update((state) => {
      const index = state.executions.findIndex((item) => item.id === run.id);
      state.executions[index] = {
        ...state.executions[index]!, inputIds: ["input-1"],
        revision: state.executions[index]!.revision + 1,
        nodes: [{ nodeId: "tool-1", status: "running", attemptId: "attempt-1" }],
      };
      state.inputs.push({
        id: "input-1", automationId: "automation-1", sourceId: "source-1",
        canonicalPath: "/inbox/file.txt", contentVersion: "hash",
        observedAt: "2026-09-29T10:00:00Z", eligibility: "eligible", claimRunId: run.id,
        snapshot: { attachment, contentVersion: "hash", sizeBytes: 5 },
      });
      state.attempts.push({
        id: "attempt-1", runId: run.id, nodeId: "tool-1", invocationId: "attempt-1",
        fingerprint: "fingerprint", state: "started", startedAt: "2026-09-29T10:00:00Z",
      });
    });
    f.lifetimes.observe(run.id, "attempt-1", effect.promise);
    throw new Error("report_write_failed");
  });
  const run = await f.service.runNowAutomation(f.job.id);
  await f.service.tick();
  const completed = await waitForOutcome(f, run.id, "failed");
  const terminalState = await f.persistence.read();
  expect(completed?.error).toBe("report_write_failed");
  expect(terminalState.inputs[0]).toMatchObject({ eligibility: "held", outcomeRef: `derived:${run.id}` });
  expect(terminalState.attempts[0]?.state).toBe("uncertain");
  expect(terminalState.executions[0]?.nodes).toMatchObject([
    { status: "interrupted", errorCode: "automation_effect_uncertain" },
  ]);
  expect(f.admission.isIdle()).toBe(false);
  const next = await f.service.runNowAutomation(f.job.id);
  await f.service.tick();
  expect((await f.service.getAutomationRun(next.id))?.status).toBe("pending");
  expect(f.execute).toHaveBeenCalledOnce();

  effect.resolve({ status: "fulfilled", ok: true });
  await vi.waitFor(() => expect(f.admission.isIdle()).toBe(true));
  expect((await f.persistence.read()).attempts[0]).toMatchObject({
    state: "uncertain", lateSettlement: { status: "succeeded" },
  });
  expect(await f.service.getAutomationRun(run.id)).toEqual(completed);
  expect(f.onError).not.toHaveBeenCalled();
  await f.service.tick();
  await waitForOutcome(f, next.id, "succeeded");
  expect(f.execute).toHaveBeenCalledTimes(2);
});

test("a later rejected graph cannot replace the already published stop outcome", async () => {
  const f = await fixture();
  const graph = deferred<SchedulerAutomationRunOutcome>();
  f.execute.mockImplementationOnce(() => graph.promise);
  const run = await f.service.runNowAutomation(f.job.id);
  await f.service.tick();
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  await f.service.stopAutomationRun(run.id);
  const cancelled = await waitForOutcome(f, run.id, "cancelled");
  expect(cancelled).toMatchObject({
    error: "automation_stop_deadline_elapsed", reportRef: `derived:${run.id}`,
  });
  await vi.waitFor(() => expect(f.admission.isIdle()).toBe(true));
  graph.reject(new Error("late_graph_failure"));
  await f.service.tick();
  expect(await f.service.getAutomationRun(run.id)).toEqual(cancelled);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.onError).not.toHaveBeenCalled();
});

test.each(["stop", "budget"] as const)(
  "%s deadline releases stalled graph admission and fences its late continuation",
  async (cause) => {
    const f = await fixture(cause === "budget" ? 10 : 60_000);
    const graph = deferred<SchedulerAutomationRunOutcome>();
    let oldSignal!: AbortSignal;
    f.execute.mockImplementationOnce(async (_job, run, signal) => {
      oldSignal = signal;
      await f.persistence.update((state) => {
        const index = state.executions.findIndex((item) => item.id === run.id);
        const execution = state.executions[index]!;
        state.executions[index] = { ...execution, revision: execution.revision + 1,
          nodes: [{ nodeId: "late", status: "running" }] };
      });
      return graph.promise;
    });
    const run = await f.service.runNowAutomation(f.job.id);
    await f.service.tick();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    if (cause === "stop") await f.service.stopAutomationRun(run.id);
    const terminal = await waitForOutcome(f, run.id, cause === "stop" ? "cancelled" : "failed");
    await vi.waitFor(() => expect(f.admission.isIdle()).toBe(true));
    expect(oldSignal.aborted).toBe(true);
    const terminalExecution = (await f.persistence.read()).executions.find((item) => item.id === run.id);

    // The old graph is still unresolved when a later run can finish.
    const next = await f.service.runNowAutomation(f.job.id);
    await f.service.tick();
    await waitForOutcome(f, next.id, "succeeded");
    const lateTool = vi.fn(async () => "unexpected effect");
    await expect(f.lifetimes.runInvocation(run.id, oldSignal, lateTool)).rejects.toThrow();
    expect(lateTool).not.toHaveBeenCalled();
    const transactions = createAutomationNodeTransactions({ persistence: f.persistence });
    await expect(transactions.recordAttempt({ runId: run.id, nodeId: "late",
      invocationId: "late-attempt", fingerprint: "late" })).rejects.toThrow("automation_run_locked");
    await expect(transactions.settleNode({ runId: run.id, nodeId: "late", status: "succeeded" }))
      .rejects.toThrow("automation_run_locked");

    graph.resolve({ status: "succeeded", reportRef: "late-report" });
    await f.service.tick();
    expect(await f.service.getAutomationRun(run.id)).toEqual(terminal);
    expect((await f.persistence.read()).executions.find((item) => item.id === run.id))
      .toEqual(terminalExecution);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.onError).not.toHaveBeenCalled();
  },
);
