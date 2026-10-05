import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import type { AutomationRevision } from "../automations/definition-contracts.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { createAutomationReportService, type AutomationRunReport } from "../automations/run-report.js";
import { createAutomationResultStore } from "../automations/result-store.js";
import { createAutomationService } from "../automations/service.js";
import { emptyAutomationJournalState, type AutomationJournalState } from "../automations/storage-records.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type { SchedulerAutomationRun, SchedulerService } from "../scheduler/contracts.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

const definition: AutomationRevision = {
  schemaVersion: 1, automationId: "auto-1", revision: 2, title: "Store",
  objective: "Store content", trigger: { kind: "manual" }, inputs: {},
  body: { kind: "sequence", id: "root", children: [{
    kind: "tool", id: "write", title: "Write result", onFailure: "stop",
    operation: { toolName: "fixture", operationId: "write", contractVersion: 1 },
    controls: {},
  }] },
  limits: DEFAULT_AUTOMATION_LIMITS,
};
const run: SchedulerAutomationRun = {
  id: "run-1", jobId: "job-1", environmentId: "dev",
  target: { kind: "automation", automationId: "auto-1", definitionRevision: 2 },
  title: "Store", timeZone: "UTC", jobRevision: 1,
  scheduledAt: "2026-09-29T10:00:00Z", trigger: "manual", status: "succeeded",
  startedAt: "2026-09-29T10:00:00Z", finishedAt: "2026-09-29T10:01:00Z",
};

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "automation-report-evidence-"));
  folders.push(folder);
  const results = createAutomationResultStore(folder);
  let state = emptyAutomationJournalState();
  state.definitions.push({ id: "def-1", automationId: "auto-1", revision: 2,
    definition, publishedAt: "2026-09-29T09:00:00Z" });
  state.executions.push({ id: run.id, automationId: "auto-1", definitionRevision: 2,
    revision: 1, inputIds: [], nodes: [{ nodeId: "write", status: "succeeded",
      resultRef: "output-1" }] });
  state.attempts.push({ id: "attempt-1", runId: run.id, nodeId: "write",
    invocationId: "invocation-1", fingerprint: "fingerprint", state: "settled",
    startedAt: "2026-09-29T10:00:00Z", settlementRef: "output-1" });
  const output = await results.save({ runId: run.id, nodeId: "write", kind: "node_output",
    value: { text: "stored", receipt: { ok: true, effect: "mutating",
      completionActions: [{ type: "write_file", target: "/tmp/result.txt" }] } },
    maxBytes: 100_000 });
  state.results.push(output);
  state.executions[0] = { ...state.executions[0]!,
    nodes: [{ nodeId: "write", status: "succeeded", resultRef: output.id }] };
  state.attempts[0] = { ...state.attempts[0]!, settlementRef: output.id };
  const persistence = {
    read: async () => structuredClone(state),
    update: async <T>(mutate: (current: AutomationJournalState) => T) => {
      const copy = structuredClone(state);
      const value = mutate(copy);
      state = copy;
      return value;
    },
  } as AutomationPersistence;
  const scheduler = {
    getAutomationRun: async () => run,
    listAutomationRuns: async () => [],
    stopAutomationRun: async () => undefined,
  } as unknown as SchedulerService;
  const service = createAutomationService({
    config: { runtimeId: "dev" } as RuntimeConfig, scheduler, persistence,
    results, tools: {} as ToolRegistry,
  });
  return { get state() { return state; }, setState(value: AutomationJournalState) { state = value; },
    results, persistence, service };
}

describe("automation report effect continuity", () => {
  it("saves bounded verified effects in the compact report and retains them after detail expiry", async () => {
    const f = await fixture();
    const created = await createAutomationReportService({
      persistence: f.persistence, results: f.results,
      now: () => Date.parse("2026-09-29T10:01:00Z"),
    }).create({ run, definition, outcome: "succeeded" });
    expect(created.report).toMatchObject({
      toolCalls: 1, toolAttempts: 1, nodeResults: [{ title: "Write result" }],
      effectSummary: { verifiedExecutions: 1, unresolvedAttempts: 0,
        entries: [{ actions: [{ type: "write_file", target: "/tmp/result.txt" }] }] },
    });
    const expired = structuredClone(f.state);
    expired.executions[0] = { ...expired.executions[0]!,
      detailsExpiredAt: "2026-10-29T10:01:00Z" };
    expired.attempts = [];
    expired.results = expired.results.filter((item) => item.id === created.record.id);
    f.setState(expired);
    const savedRun = { ...run, reportRef: created.record.id };
    const scheduler = { getAutomationRun: async () => savedRun,
      listAutomationRuns: async () => [], stopAutomationRun: async () => undefined,
    } as unknown as SchedulerService;
    const service = createAutomationService({
      config: { runtimeId: "dev" } as RuntimeConfig, scheduler, persistence: f.persistence,
      results: f.results, tools: {} as ToolRegistry,
    });
    const read = await service.getRun(run.id);
    expect(read.report?.effectSummary?.entries[0]?.actions)
      .toEqual([{ type: "write_file", target: "/tmp/result.txt" }]);
    expect(read.detailsExpiredAt).toBeDefined();
    expect(read.report?.toolAttempts).toBe(1);
  });

  it("enriches a legacy report from retained receipts without claiming missing effects are absent", async () => {
    const f = await fixture();
    const legacy: AutomationRunReport = {
      runId: run.id, automationId: "auto-1", definitionRevision: 2,
      outcome: "succeeded", startedAt: run.startedAt!, finishedAt: run.finishedAt!,
      inputIds: [], inputVersions: [], nodeResults: [{ nodeId: "write", status: "succeeded" }],
      uncertainEffects: [], lateEvidence: [], artifacts: [], modelCalls: 0, toolCalls: null,
    };
    const record = await f.results.save({ runId: run.id, kind: "report", value: legacy,
      maxBytes: 100_000 });
    const current = structuredClone(f.state);
    current.results.push(record);
    f.setState(current);
    const scheduler = { getAutomationRun: async () => ({ ...run, reportRef: record.id }),
      listAutomationRuns: async () => [], stopAutomationRun: async () => undefined,
    } as unknown as SchedulerService;
    const service = createAutomationService({
      config: { runtimeId: "dev" } as RuntimeConfig, scheduler, persistence: f.persistence,
      results: f.results, tools: {} as ToolRegistry,
    });
    const read = await service.getRun(run.id);
    expect(read.report).toMatchObject({
      toolCalls: 1, nodeResults: [{ title: "Write result" }],
      effectSummary: { verifiedExecutions: 1 },
    });
    const expired = structuredClone(current);
    expired.executions[0] = { ...expired.executions[0]!,
      detailsExpiredAt: "2026-10-29T10:01:00Z" };
    expired.attempts = [];
    expired.results = [record];
    f.setState(expired);
    const historical = await service.getRun(run.id);
    expect(historical.report?.effectSummary).toBeUndefined();
    expect(historical.report?.toolCalls).toBeNull();
    expect(historical.report?.toolAttempts).toBeUndefined();
  });

  it("adds later evidence to a saved uncertain receipt without rewriting the original outcome", async () => {
    const f = await fixture();
    const uncertain = structuredClone(f.state);
    uncertain.attempts[0] = { ...uncertain.attempts[0]!, state: "uncertain" };
    f.setState(uncertain);
    const created = await createAutomationReportService({
      persistence: f.persistence, results: f.results,
    }).create({ run, definition, outcome: "failed" });
    expect(created.report.effectSummary?.entries[0]?.outcome).toBe("uncertain");
    const settledLater = structuredClone(f.state);
    settledLater.attempts[0] = { ...settledLater.attempts[0]!,
      lateSettlement: { revision: 2, observedAt: "2026-09-29T10:02:00Z",
        status: "succeeded" } };
    f.setState(settledLater);
    const scheduler = {
      getAutomationRun: async () => ({ ...run, status: "failed" as const,
        reportRef: created.record.id }),
      listAutomationRuns: async () => [], stopAutomationRun: async () => undefined,
    } as unknown as SchedulerService;
    const service = createAutomationService({
      config: { runtimeId: "dev" } as RuntimeConfig, scheduler, persistence: f.persistence,
      results: f.results, tools: {} as ToolRegistry,
    });
    const read = await service.getRun(run.id);
    expect(read.report?.outcome).toBe("failed");
    expect(read.report?.toolCalls).toBeNull();
    expect(read.report?.toolAttempts).toBe(1);
    expect(read.report?.effectSummary?.entries[0]).toMatchObject({
      outcome: "uncertain", lateEvidence: { status: "succeeded" },
      actions: [{ type: "write_file", target: "/tmp/result.txt" }],
    });
  });
});
