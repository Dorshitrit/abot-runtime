import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createFileAttachmentStore } from "../attachments/store.js";
import { createAutomationPersistence } from "../automations/persistence.js";
import { createAutomationResultStore } from "../automations/result-store.js";
import { createAutomationService } from "../automations/service.js";
import { commitInputObservation, findSourceVersion } from "../automations/input-ledger.js";
import { recordAutomationLateSettlements } from "../automations/late-settlement.js";
import { maintainAutomationRetention,
  AUTOMATION_DETAIL_RETENTION_MS,
  AUTOMATION_REPORT_RETENTION_MS,
} from "../automations/retention.js";
import { createFileSchedulerStore } from "../scheduler/file-store.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type { SchedulerAutomationRun, SchedulerService } from "../scheduler/contracts.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "automation-retention-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const journal = join(root, "journal");
  const store = createFileSchedulerStore(journal);
  const release = await store.acquire();
  cleanups.push(release);
  const persistence = createAutomationPersistence(store);
  const results = createAutomationResultStore(root);
  const attachments = createFileAttachmentStore({ attachmentsDir: join(root, "attachments") });
  const terminalAt = Date.parse("2026-01-01T00:00:00.000Z");
  const originalPath = join(root, "original.txt");
  await writeFile(originalPath, "original stays", "utf8");
  const snapshot = await attachments.saveAttachment({
    sessionId: "run-1", requestId: "input-1", kind: "file",
    mimeType: "text/plain", bytes: new TextEncoder().encode("snapshot"),
  });
  const detail = await results.save({
    runId: "run-1", nodeId: "node-1", kind: "node_output",
    value: { text: "detail" }, maxBytes: 10_000,
    at: new Date(terminalAt).toISOString(),
  });
  const report = await results.save({
    runId: "run-1", kind: "report", value: { outcome: "succeeded" },
    maxBytes: 10_000, at: new Date(terminalAt).toISOString(),
  });
  await persistence.update((state) => {
    state.definitions.push({
      id: "definition-1", automationId: "auto-1", revision: 1,
      publishedAt: new Date(terminalAt).toISOString(),
      definition: {
        schemaVersion: 1, automationId: "auto-1", revision: 1,
        title: "Intake", objective: "Intake", trigger: { kind: "manual" },
        inputs: {}, body: { kind: "sequence", id: "root", children: [] },
        limits: { maxConcurrentNodes: 1, maxModelCallsPerRun: 1,
          maxToolCallsPerRun: 1, maxRunDurationMs: 60_000,
          maxRunsPerDay: 1, maxStoredArtifactBytes: 10_000,
          stopReportDeadlineMs: 1_000 },
      },
    });
    state.executions.push({
      id: "run-1", automationId: "auto-1", definitionRevision: 1,
      revision: 1, inputIds: ["input-1"],
      nodes: [{ nodeId: "node-1", status: "succeeded", resultRef: detail.id }],
      reportRef: report.id, terminalAt: new Date(terminalAt).toISOString(),
    });
    state.inputs.push({
      id: "input-1", automationId: "auto-1", sourceId: "folder",
      canonicalPath: originalPath, contentVersion: "hash",
      observedAt: new Date(terminalAt).toISOString(), eligibility: "eligible",
      claimRunId: "run-1", outcomeRef: report.id,
      snapshot: { attachment: snapshot, contentVersion: "hash", sizeBytes: 8 },
    });
    state.results.push(detail, report);
  });
  return { root, journal, store, release, persistence, results, attachments,
    terminalAt, originalPath, snapshot, detail, report };
}

test("30-day detail cleanup retains report and replay snapshot until 90 days", async () => {
  const f = await fixture();
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + AUTOMATION_DETAIL_RETENTION_MS + 1,
  });
  const afterDetail = await f.persistence.read();
  expect(afterDetail.results.map((item) => item.id)).toEqual([f.report.id]);
  expect(afterDetail.executions[0]?.detailsExpiredAt).toBeDefined();
  expect(afterDetail.executions[0]?.reportExpiredAt).toBeUndefined();
  expect(afterDetail.inputs[0]?.snapshot).toBeDefined();
  await expect(f.results.read(f.report)).resolves.toMatchObject({ outcome: "succeeded" });
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + AUTOMATION_REPORT_RETENTION_MS + 1,
  });
  const afterReport = await f.persistence.read();
  expect(afterReport.results).toEqual([]);
  expect(afterReport.executions[0]?.reportExpiredAt).toBeDefined();
  expect(afterReport.inputs[0]).toMatchObject({
    canonicalPath: f.originalPath, contentVersion: "hash", claimRunId: "run-1",
  });
  expect(afterReport.inputs[0]?.snapshot).toBeUndefined();
  const run: SchedulerAutomationRun = {
    id: "run-1", jobId: "job-1", environmentId: "dev",
    target: { kind: "automation", automationId: "auto-1", definitionRevision: 1 },
    title: "Intake", timeZone: "UTC", jobRevision: 1,
    scheduledAt: new Date(f.terminalAt).toISOString(), trigger: "manual",
    status: "succeeded", reportRef: f.report.id,
    finishedAt: new Date(f.terminalAt).toISOString(),
  };
  const service = createAutomationService({
    config: { runtimeId: "dev", paths: { agentWorkDir: f.root } } as RuntimeConfig,
    scheduler: {
      getAutomationRun: async () => run,
      listAutomationRuns: async () => [],
      stopAutomationRun: async () => run,
    } as unknown as SchedulerService,
    persistence: f.persistence, results: f.results,
    tools: { listDefinitions: () => [], listNormalInvocations: () => [] } as unknown as ToolRegistry,
  });
  expect(await service.getRun("run-1")).toMatchObject({
    report: null, reportState: "expired", automationId: "auto-1",
  });
  await expect(f.attachments.resolveAttachment(f.snapshot)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.originalPath, "utf8")).toBe("original stays");
});

test("retirement marker survives a crash before file deletion and retries on the next owner", async () => {
  const f = await fixture();
  let failOnce = true;
  const flakyResults = {
    ...f.results,
    discardUncommitted: async (record: typeof f.detail) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected_delete_failure");
      }
      return f.results.discardUncommitted(record);
    },
  };
  const now = f.terminalAt + AUTOMATION_DETAIL_RETENTION_MS + 1;
  await expect(maintainAutomationRetention({
    persistence: f.persistence, results: flakyResults, attachments: f.attachments, now,
  })).rejects.toThrow("injected_delete_failure");
  expect((await f.persistence.read()).executions[0]?.detailsExpiredAt)
    .toBeDefined();
  await expect(f.results.read(f.detail)).resolves.toMatchObject({ text: "detail" });
  cleanups.splice(cleanups.indexOf(f.release), 1);
  await f.release();
  const restarted = createFileSchedulerStore(f.journal);
  const releaseRestarted = await restarted.acquire();
  cleanups.push(releaseRestarted);
  const persistence = createAutomationPersistence(restarted);
  await maintainAutomationRetention({
    persistence, results: f.results, attachments: f.attachments, now,
  });
  expect((await persistence.read()).results.map((item) => item.id)).toEqual([f.report.id]);
  await expect(f.results.read(f.detail)).rejects.toMatchObject({ code: "ENOENT" });
});

test("retired snapshots preserve dedup history without exhausting future input admission", async () => {
  const f = await fixture();
  await f.persistence.update((state) => {
    const { snapshot: _snapshot, ...consumed } = state.inputs[0]!;
    state.inputs.push(...Array.from({ length: 1_000 }, (_, index) => ({
      ...consumed, id: `historical-${index}`, contentVersion: `historical-${index}`,
    })));
  });
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + AUTOMATION_REPORT_RETENTION_MS + 1,
  });
  const attachment = await f.attachments.saveAttachment({
    sessionId: "new-run", requestId: "new-input", kind: "file",
    mimeType: "text/plain", bytes: new TextEncoder().encode("new input"),
  });
  await f.persistence.update((state) => {
    expect(findSourceVersion(state.inputs, f.originalPath, "hash"))
      .toMatchObject({ id: "input-1", claimRunId: "run-1", outcomeRef: f.report.id });
    expect(state.inputs.every((record) => !record.snapshot)).toBe(true);
    commitInputObservation({ state, runId: "new-run", newFiles: [{
      id: "new-input", automationId: "auto-1", sourceId: "folder",
      canonicalPath: f.originalPath, contentVersion: "new-version",
      observedAt: new Date(f.terminalAt + AUTOMATION_REPORT_RETENTION_MS + 1).toISOString(),
      eligibility: "eligible", snapshot: { attachment, contentVersion: "new-version", sizeBytes: 9 },
    }] });
  });
  const after = await f.persistence.read();
  expect(after.inputs).toHaveLength(1_002);
  expect(after.inputs.filter((record) => record.snapshot)).toHaveLength(1);
  expect(findSourceVersion(after.inputs, f.originalPath, "hash")?.id).toBe("input-1");
});

test("a newer replay keeps the shared immutable snapshot until its own report expires", async () => {
  const f = await fixture();
  await f.persistence.update((state) => {
    state.executions.push({
      id: "run-2", automationId: "auto-1", definitionRevision: 1,
      revision: 1, inputIds: ["input-1"], nodes: [],
      reportRef: "derived:run-2",
      terminalAt: new Date(f.terminalAt + 60 * 24 * 60 * 60_000).toISOString(),
    });
  });
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + AUTOMATION_REPORT_RETENTION_MS + 1,
  });
  expect((await f.persistence.read()).inputs[0]?.snapshot).toBeDefined();
  await f.attachments.resolveAttachment(f.snapshot);
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + 60 * 24 * 60 * 60_000 + AUTOMATION_REPORT_RETENTION_MS + 1,
  });
  expect((await f.persistence.read()).inputs[0]?.snapshot).toBeUndefined();
});

test.each([true, false])("held snapshots expire after settled reports, saved outcome reference: %s", async (savedOutcome) => {
  const f = await fixture();
  await f.persistence.update((state) => {
    const { outcomeRef, ...record } = state.inputs[0]!;
    state.inputs[0] = { ...record, eligibility: "held", ...(savedOutcome ? { outcomeRef } : {}) };
  });
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + AUTOMATION_REPORT_RETENTION_MS - 1,
  });
  expect((await f.persistence.read()).inputs[0]?.snapshot).toBeDefined();
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + AUTOMATION_REPORT_RETENTION_MS + 1,
  });
  const retired = (await f.persistence.read()).inputs[0];
  expect(retired?.snapshot).toBeUndefined();
  expect(retired).toMatchObject({ eligibility: "held", claimRunId: "run-1", outcomeRef: f.report.id });
});

test("held snapshots remain protected by an uncertain effect or a newer replay", async () => {
  const f = await fixture();
  await f.persistence.update((state) => {
    state.inputs[0] = { ...state.inputs[0]!, eligibility: "held" };
    state.attempts.push({ id: "uncertain-attempt", runId: "run-1", nodeId: "node-1",
      invocationId: "invocation-1", fingerprint: "fingerprint", state: "uncertain",
      startedAt: new Date(f.terminalAt).toISOString() });
  });
  const now = f.terminalAt + AUTOMATION_REPORT_RETENTION_MS + 1;
  await maintainAutomationRetention({ persistence: f.persistence, results: f.results, attachments: f.attachments, now });
  expect((await f.persistence.read()).inputs[0]?.snapshot).toBeDefined();
  await f.persistence.update((state) => {
    state.attempts[0] = { ...state.attempts[0]!, state: "settled",
      settledAt: new Date(f.terminalAt + 1).toISOString(), settlementRef: "settlement" };
    state.executions.push({ id: "new-replay", automationId: "auto-1", definitionRevision: 1,
      revision: 1, inputIds: ["input-1"], nodes: [], reportRef: "derived:new-replay",
      terminalAt: new Date(now - 1).toISOString() });
  });
  await maintainAutomationRetention({ persistence: f.persistence, results: f.results, attachments: f.attachments, now });
  expect((await f.persistence.read()).inputs[0]?.snapshot).toBeDefined();
});

test.each([
  { ok: true, replay: false },
  { ok: false, replay: false },
  { ok: true, replay: true },
])("fulfilled late effects release expired payloads without rewriting uncertainty: %o", async ({ ok, replay }) => {
  const f = await fixture();
  await f.persistence.update((state) => {
    state.inputs[0] = { ...state.inputs[0]!, eligibility: "held" };
    state.attempts.push({ id: "late-attempt", runId: "run-1", nodeId: "node-1",
      invocationId: "late-invocation", fingerprint: "fingerprint", state: "uncertain",
      startedAt: new Date(f.terminalAt).toISOString() });
  });
  await recordAutomationLateSettlements({ persistence: f.persistence, runId: "run-1",
    now: () => f.terminalAt + 1,
    observed: [{ invocationId: "late-invocation", settlement: { status: "fulfilled", ok } }],
  });
  const originalAttempt = (await f.persistence.read()).attempts[0];
  expect(originalAttempt).toMatchObject({ state: "uncertain",
    lateSettlement: { status: ok ? "succeeded" : "failed" } });
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + AUTOMATION_DETAIL_RETENTION_MS + 1,
  });
  const afterDetail = await f.persistence.read();
  expect(afterDetail.executions[0]?.detailsExpiredAt).toBeDefined();
  expect(afterDetail.results.map((result) => result.id)).toEqual([f.report.id]);
  expect(afterDetail.inputs[0]?.snapshot).toBeDefined();
  if (replay) await f.persistence.update((state) => {
    state.executions.push({ id: "recent-replay", automationId: "auto-1", definitionRevision: 1,
      revision: 1, inputIds: ["input-1"], nodes: [], reportRef: "derived:recent-replay",
      terminalAt: new Date(f.terminalAt + 60 * 24 * 60 * 60_000).toISOString() });
  });
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + AUTOMATION_REPORT_RETENTION_MS + 1,
  });
  const afterReport = await f.persistence.read();
  expect(afterReport.executions[0]?.reportExpiredAt).toBeDefined();
  expect(afterReport.results).toEqual([]);
  expect(Boolean(afterReport.inputs[0]?.snapshot)).toBe(replay);
  expect(afterReport.attempts[0]).toEqual(originalAttempt);
  expect(afterReport.inputs[0]).toMatchObject({ eligibility: "held", outcomeRef: f.report.id });
});

test.each(["started", "uncertain", "rejected"] as const)("%s effects still protect reports and snapshots", async (kind) => {
  const f = await fixture();
  await f.persistence.update((state) => {
    state.inputs[0] = { ...state.inputs[0]!, eligibility: "held" };
    state.attempts.push({ id: "protected-attempt", runId: "run-1", nodeId: "node-1",
      invocationId: "protected-invocation", fingerprint: "fingerprint",
      state: kind === "started" ? "started" : "uncertain",
      startedAt: new Date(f.terminalAt).toISOString() });
  });
  if (kind === "rejected") await recordAutomationLateSettlements({
    persistence: f.persistence, runId: "run-1", now: () => f.terminalAt + 1,
    observed: [{ invocationId: "protected-invocation",
      settlement: { status: "rejected", errorCode: "tool_execution_failed" } }],
  });
  const originalAttempt = (await f.persistence.read()).attempts[0];
  await maintainAutomationRetention({
    persistence: f.persistence, results: f.results, attachments: f.attachments,
    now: f.terminalAt + AUTOMATION_REPORT_RETENTION_MS + 1,
  });
  const protectedState = await f.persistence.read();
  expect(protectedState.executions[0]?.detailsExpiredAt).toBeUndefined();
  expect(protectedState.executions[0]?.reportExpiredAt).toBeUndefined();
  expect(protectedState.results).toHaveLength(2);
  expect(protectedState.inputs[0]?.snapshot).toBeDefined();
  expect(protectedState.attempts[0]).toEqual(originalAttempt);
});
