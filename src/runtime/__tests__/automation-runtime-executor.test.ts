import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { executeToolCall } from "../../capabilities/tool-executor.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import type { RuntimeConfig, RuntimePaths } from "../ports.js";
import type {
  SchedulerAutomationJob,
  SchedulerAutomationRun,
  SchedulerAutomationRunOutcome,
  SchedulerSnapshot,
} from "../scheduler/contracts.js";
import { createAutomationRuntimeExecutor } from "../automations/runtime-executor.js";
import { buildAutomationRunReport } from "../automations/run-report.js";
import { createAutomationResultStore } from "../automations/result-store.js";
import type { AutomationRevision } from "../automations/definition-contracts.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import {
  emptyAutomationJournalState,
  parseAutomationJournalState,
  type AutomationJournalState,
} from "../automations/storage-records.js";
import {
  createAutomationToolLifetimes,
  type AutomationToolLifetimes,
} from "../automations/tool-lifetimes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(execute: (
  signal: AbortSignal,
) => Promise<SchedulerAutomationRunOutcome> = async () => ({
  status: "succeeded", reportRef: "report-1",
}), maxRunDurationMs = 60_000,
toolLifetimes: AutomationToolLifetimes = createAutomationToolLifetimes()) {
  const root = await mkdtemp(join(tmpdir(), "automation-executor-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths: RuntimePaths = {
    rootDir: root, runtimeDir: join(root, "runtime"),
    agentWorkDir: join(root, "work"), sessionsDir: join(root, "sessions"),
    attachmentsDir: join(root, "attachments"), workspaceDir: join(root, "workspace"),
    sharedDir: join(root, "shared"), compiledDir: join(root, "compiled"),
    traceFile: join(root, "trace.jsonl"),
  };
  const job: SchedulerAutomationJob = {
    id: "job-1", environmentId: "dev",
    target: { kind: "automation", automationId: "auto-1", definitionRevision: 1 },
    title: "Check", timeZone: "UTC", schedule: { kind: "manual" },
    state: "active", createdAt: "2026-09-29T10:00:00Z",
    updatedAt: "2026-09-29T10:00:00Z", nextRunAt: null, revision: 1,
  };
  const run: SchedulerAutomationRun = {
    id: "run-1", jobId: job.id, environmentId: "dev", target: job.target,
    title: job.title, timeZone: job.timeZone, jobRevision: job.revision,
    scheduledAt: "2026-09-29T10:00:00Z", trigger: "manual", status: "running",
  };
  const definition: AutomationRevision = {
    schemaVersion: 1, automationId: "auto-1", revision: 1,
    title: "Check", objective: "Check", trigger: { kind: "manual" },
    inputs: {}, body: { kind: "sequence", id: "root", children: [] },
    limits: {
      maxConcurrentNodes: 2, maxModelCallsPerRun: 1, maxToolCallsPerRun: 1,
      maxRunDurationMs, maxRunsPerDay: 1,
      maxStoredArtifactBytes: 1_000_000, stopReportDeadlineMs: 10,
    },
  };
  const state = emptyAutomationJournalState();
  state.definitions.push({ id: "def-1", automationId: "auto-1", revision: 1,
    definition, publishedAt: "2026-09-29T10:00:00Z" });
  state.executions.push({
    id: run.id, automationId: "auto-1", definitionRevision: 1,
    revision: 1, inputIds: [], nodes: [],
  });
  const executor = createAutomationRuntimeExecutor({
    config: { runtimeId: "dev", paths } as RuntimeConfig,
    persistence: {
      read: async () => structuredClone(state),
      update: async <T>(mutate: (current: AutomationJournalState) => T): Promise<T> => mutate(state),
    } as AutomationPersistence,
    attachments: createFileAttachmentStore({ attachmentsDir: paths.attachmentsDir }),
    results: createAutomationResultStore(paths.runtimeDir),
    toolLifetimes,
    execute: (_job, _run, signal) => execute(signal),
  });
  return { executor, job, run, state };
}

test("stop report keeps admission while the abort-raced Tool implementation is in flight", async () => {
  const lifetimes = createAutomationToolLifetimes();
  let effectStarted!: () => void;
  const startedEffect = new Promise<void>((resolve) => { effectStarted = resolve; });
  let finishEffect!: (value: { ok: boolean; output: string; producedNewInformation: boolean }) => void;
  const underlying = new Promise<{ ok: boolean; output: string; producedNewInformation: boolean }>(
    (resolve) => { finishEffect = resolve; },
  );
  let finishGraph!: () => void;
  const graphHold = new Promise<void>((resolve) => { finishGraph = resolve; });
  const f = await fixture(async (signal) => {
    const result = await executeToolCall({ tool: "mutator", params: {} }, {
      abortSignal: signal,
      implementations: { mutator: async () => {
        effectStarted();
        return underlying;
      } },
      onUnderlyingSettlement: (settled) => lifetimes.observe("run-1", "attempt-1", settled),
    });
    expect(result.errorCode).toBe("request_aborted");
    await graphHold;
    return { status: "cancelled", reportRef: "derived:run-1" };
  }, 60_000, lifetimes);
  f.state.attempts.push({
    id: "attempt-1", runId: f.run.id, nodeId: "tool",
    invocationId: "attempt-1", fingerprint: "fingerprint", state: "started",
    startedAt: "2026-09-29T10:00:00Z",
  });
  const run = f.executor.start(f.job, f.run);
  await startedEffect;
  let resourcesReleased = false;
  void run.resourcesSettled.then(() => { resourcesReleased = true; });
  f.executor.stop(f.run.id);
  const outcome = await run.outcome;
  expect(outcome).toEqual({
    status: "cancelled", error: "automation_stop_deadline_elapsed",
    reportRef: "derived:run-1",
  });
  f.run.status = "cancelled";
  f.run.reportRef = outcome.reportRef;
  f.executor.settle(f.run, f.state, outcome);
  const terminalRevision = f.state.executions[0]?.revision;
  await Promise.resolve();
  await Promise.resolve();
  expect(resourcesReleased).toBe(false);
  finishEffect({ ok: true, output: "effect completed", producedNewInformation: true });
  await run.resourcesSettled;
  expect(resourcesReleased).toBe(true);
  finishGraph();
  expect(f.state.executions[0]?.revision).toBe((terminalRevision ?? 0) + 1);
  expect(f.state.attempts[0]).toMatchObject({
    state: "uncertain",
    lateSettlement: {
      revision: (terminalRevision ?? 0) + 1,
      status: "succeeded",
    },
  });
  expect(f.run.status).toBe("cancelled");
  expect(f.run.reportRef).toBe("derived:run-1");
  const report = buildAutomationRunReport({
    run: f.run,
    definition: f.state.definitions[0]!.definition,
    execution: f.state.executions[0]!,
    inputs: [],
    attempts: f.state.attempts,
    results: [],
    outcome: "cancelled",
    finishedAt: "2026-09-29T10:01:00Z",
  });
  expect(report.outcome).toBe("cancelled");
  expect(report.lateEvidence).toMatchObject([{
    attemptId: "attempt-1",
    revision: (terminalRevision ?? 0) + 1,
    status: "succeeded",
  }]);
  expect(parseAutomationJournalState(structuredClone(f.state)).attempts[0]?.lateSettlement)
    .toMatchObject({ status: "succeeded" });
});

test("stop deadline detaches stalled graph work when no Tool owns an effect", async () => {
  let finish!: (outcome: SchedulerAutomationRunOutcome) => void;
  let signalSeen: AbortSignal | undefined;
  const unsettled = new Promise<SchedulerAutomationRunOutcome>((resolve) => { finish = resolve; });
  const f = await fixture((signal) => {
    signalSeen = signal;
    return unsettled;
  });
  const started = f.executor.start(f.job, f.run);
  let resourcesReleased = false;
  void started.resourcesSettled.then(() => { resourcesReleased = true; });
  // Let the definition read and actual execution begin before requesting stop.
  await Promise.resolve();
  await Promise.resolve();
  f.executor.stop(f.run.id);
  expect(signalSeen?.aborted).toBe(true);
  expect(await started.outcome).toEqual({
    status: "cancelled", error: "automation_stop_deadline_elapsed",
    reportRef: "derived:run-1",
  });
  await started.resourcesSettled;
  expect(resourcesReleased).toBe(true);
  finish({ status: "cancelled", reportRef: "derived:run-1" });
});

test("run budget releases admission independently of stalled graph work", async () => {
  let finish!: (outcome: SchedulerAutomationRunOutcome) => void;
  const unsettled = new Promise<SchedulerAutomationRunOutcome>((resolve) => { finish = resolve; });
  const f = await fixture(async () => unsettled, 10);
  const started = f.executor.start(f.job, f.run);
  let resourcesReleased = false;
  void started.resourcesSettled.then(() => { resourcesReleased = true; });
  expect(await started.outcome).toEqual({
    status: "failed", error: "automation_run_deadline_elapsed",
    reportRef: "derived:run-1",
  });
  await started.resourcesSettled;
  expect(resourcesReleased).toBe(true);
  finish({ status: "failed", reportRef: "derived:run-1" });
});

test("terminal derived report holds uncertain inputs and records execution revision", async () => {
  const f = await fixture();
  f.state.inputs.push({
    id: "input-1", automationId: "auto-1", sourceId: "folder",
    canonicalPath: "/inbox/file.txt", contentVersion: "hash",
    observedAt: "2026-09-29T10:00:00Z", eligibility: "eligible",
    claimRunId: f.run.id,
  });
  f.state.executions[0] = {
    ...f.state.executions[0]!, inputIds: ["input-1"],
    nodes: [{ nodeId: "tool", status: "running", attemptId: "attempt-1" }],
  };
  f.state.attempts.push({
    id: "attempt-1", runId: f.run.id, nodeId: "tool",
    invocationId: "attempt-1", fingerprint: "fingerprint", state: "started",
    startedAt: "2026-09-29T10:00:00Z",
  });
  f.executor.settle(f.run, f.state, {
    status: "cancelled", reportRef: "derived:run-1",
  });
  expect(f.state.executions[0]).toMatchObject({
    revision: 2, reportRef: "derived:run-1",
    nodes: [{ status: "interrupted", errorCode: "automation_effect_uncertain" }],
  });
  expect(f.state.attempts[0]?.state).toBe("uncertain");
  expect(f.state.inputs[0]).toMatchObject({
    eligibility: "held", outcomeRef: "derived:run-1",
  });
});

test("normal completion requires the durable report record", async () => {
  const f = await fixture();
  const outcome: SchedulerAutomationRunOutcome = {
    status: "succeeded", reportRef: "report-1",
  };
  expect(() => f.executor.settle(f.run, f.state, outcome))
    .toThrow("automation_report_missing");
  f.state.results.push({
    id: "report-1", runId: f.run.id, kind: "report",
    storageRef: "run-1/report.json", digest: "digest", sizeBytes: 1,
    createdAt: "2026-09-29T10:00:00Z",
  });
  f.executor.settle(f.run, f.state, outcome);
  expect(f.state.executions[0]).toMatchObject({
    revision: 2, reportRef: "report-1",
  });
});

test("capacity fallback accepts a derived success only after every node and effect settled", async () => {
  const f = await fixture();
  f.state.executions[0] = {
    ...f.state.executions[0]!,
    nodes: [{ nodeId: "tool", status: "succeeded" }],
  };
  f.state.inputs.push({
    id: "input-1", automationId: "auto-1", sourceId: "folder",
    canonicalPath: "/inbox/file.txt", contentVersion: "hash",
    observedAt: "2026-09-29T10:00:00Z", eligibility: "eligible",
    claimRunId: f.run.id,
  });
  f.executor.settle(f.run, f.state, {
    status: "succeeded", reportRef: "derived:run-1",
  });
  expect(f.state.executions[0]).toMatchObject({
    reportRef: "derived:run-1", nodes: [{ status: "succeeded" }],
  });
  expect(f.state.inputs[0]).toMatchObject({
    eligibility: "eligible", outcomeRef: "derived:run-1",
  });
  const unsafe = await fixture();
  unsafe.state.executions[0] = {
    ...unsafe.state.executions[0]!,
    nodes: [{ nodeId: "tool", status: "running" }],
  };
  expect(() => unsafe.executor.settle(unsafe.run, unsafe.state, {
    status: "succeeded", reportRef: "derived:run-1",
  })).toThrow("automation_run_not_settled");
});

test("startup recovery releases pending claims and holds interrupted claims", async () => {
  const f = await fixture();
  const pending: SchedulerAutomationRun = { ...f.run, id: "pending", status: "missed" };
  const interrupted: SchedulerAutomationRun = { ...f.run, id: "interrupted", status: "interrupted" };
  const scheduler: SchedulerSnapshot = {
    schemaVersion: 1, jobs: [f.job], runs: [pending, interrupted],
  };
  for (const run of [pending, interrupted]) {
    f.state.executions.push({
      id: run.id, automationId: "auto-1", definitionRevision: 1,
      revision: 1, inputIds: [run.id], nodes: [],
    });
    f.state.inputs.push({
      id: run.id, automationId: "auto-1", sourceId: "folder",
      canonicalPath: `/inbox/${run.id}.txt`, contentVersion: run.id,
      observedAt: "2026-09-29T10:00:00Z", eligibility: "eligible",
      claimRunId: run.id,
    });
  }
  f.executor.recover(scheduler, f.state, [pending.id, interrupted.id]);
  expect(pending.reportRef).toBe("derived:pending");
  expect(interrupted.reportRef).toBe("derived:interrupted");
  expect(f.state.inputs.find((item) => item.id === pending.id)?.claimRunId).toBeUndefined();
  expect(f.state.inputs.find((item) => item.id === interrupted.id)).toMatchObject({
    claimRunId: interrupted.id, eligibility: "held",
  });
});
