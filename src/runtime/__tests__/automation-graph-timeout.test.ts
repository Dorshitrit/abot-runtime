import { afterEach, expect, test, vi } from "vitest";
import type { AutomationRevision } from "../automations/definition-contracts.js";
import { executeAutomationGraph, type AutomationStepCompletion } from "../automations/graph-executor.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import { createAutomationNodeTransactions } from "../automations/node-transactions.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";

afterEach(() => vi.useRealTimers());

function fixture(onFailure: "stop" | "skip" = "stop", nodeIds = ["active", "pending"]) {
  vi.useFakeTimers();
  let state = emptyAutomationJournalState();
  const persistence: AutomationPersistence = {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const copy = structuredClone(state);
      const result = mutate(copy);
      state = copy;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
  const transactions = createAutomationNodeTransactions({ persistence });
  const definition: AutomationRevision = {
    schemaVersion: 1, automationId: "automation", revision: 1,
    title: "Bounded graph", objective: "Test deadline outcome", trigger: { kind: "manual" }, inputs: {},
    limits: { ...DEFAULT_AUTOMATION_LIMITS, maxRunDurationMs: 20, stopReportDeadlineMs: 10 },
    body: { kind: "sequence", id: "root", children: nodeIds.map((id) => ({
      kind: "tool", id, title: id, onFailure,
      operation: { toolName: "fixture", operationId: "read", contractVersion: 1 }, controls: {},
    })) },
  };
  const compiled = compileAutomationGraph(definition);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const abort = new AbortController();
  const calls: string[] = [];
  const run = (execute: (signal: AbortSignal) => Promise<AutomationStepCompletion>) =>
    executeAutomationGraph({ runId: "run", automationId: "automation", definition,
      inputIds: [], graph: compiled.graph, transactions, abortSignal: abort.signal,
      executeStep: (step, signal) => { calls.push(step.id); return execute(signal); } });
  return { run, transactions, abort, calls };
}

function observeAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

test.each([
  { onFailure: "stop", result: "throw" }, { onFailure: "skip", result: "throw" },
  { onFailure: "stop", result: "cancelled" }, { onFailure: "skip", result: "cancelled" },
] as const)("timeout is failed for $result with onFailure=$onFailure", async ({ onFailure, result }) => {
  const f = fixture(onFailure);
  const running = f.run(async (signal) => {
    await observeAbort(signal);
    if (result === "throw") throw signal.reason;
    return { status: "cancelled", errorCode: "automation_run_stopped" };
  });
  await vi.advanceTimersByTimeAsync(21);
  expect(await running).toMatchObject({ status: "failed", errorCode: "automation_run_duration_exceeded" });
  expect(f.calls).toEqual(["active"]);
  expect((await f.transactions.get("run"))?.nodes[0]).toMatchObject({
    status: "failed", errorCode: "automation_run_duration_exceeded",
  });
});

test("an external stop that wins before the timer remains cancelled", async () => {
  const f = fixture();
  let release!: () => void;
  const running = f.run(async (signal) => {
    await observeAbort(signal);
    await new Promise<void>((resolve) => { release = resolve; });
    throw signal.reason;
  });
  await vi.advanceTimersByTimeAsync(1);
  f.abort.abort(new Error("user_stop"));
  await vi.advanceTimersByTimeAsync(25);
  release();
  expect(await running).toMatchObject({ status: "cancelled" });
  expect((await f.transactions.get("run"))?.nodes[0]).toMatchObject({
    status: "cancelled", errorCode: "automation_run_stopped",
  });
});

test("a stop after the timer does not replace the budget failure", async () => {
  const f = fixture();
  let release!: () => void;
  const running = f.run(async (signal) => {
    await observeAbort(signal);
    await new Promise<void>((resolve) => { release = resolve; });
    throw signal.reason;
  });
  await vi.advanceTimersByTimeAsync(21);
  f.abort.abort(new Error("later_stop"));
  release();
  expect(await running).toMatchObject({ status: "failed", errorCode: "automation_run_duration_exceeded" });
});

test("budget failure preserves an uncertain mutating attempt", async () => {
  const f = fixture("skip");
  const running = f.run(async (signal) => {
    await f.transactions.recordAttempt({ runId: "run", nodeId: "active",
      invocationId: "effect", fingerprint: "fingerprint" });
    await observeAbort(signal);
    throw signal.reason;
  });
  await vi.advanceTimersByTimeAsync(21);
  const outcome = await running;
  expect(outcome).toMatchObject({ status: "failed", errorCode: "automation_run_duration_exceeded" });
  expect(outcome.nodeResults.get("active")).toMatchObject({
    status: "failed", errorCode: "automation_effect_uncertain", uncertain: true,
  });
});

test("a result saved after the timer remains evidence but cannot make the run successful", async () => {
  const f = fixture();
  const running = f.run(async (signal) => {
    await observeAbort(signal);
    await f.transactions.settleNode({ runId: "run", nodeId: "active", status: "succeeded",
      result: { id: "result", runId: "run", nodeId: "active", kind: "node_output",
        storageRef: "automation-results/result.json", digest: "digest", sizeBytes: 1,
        createdAt: new Date().toISOString() } });
    return { status: "succeeded" };
  });
  await vi.advanceTimersByTimeAsync(21);
  expect(await running).toMatchObject({ status: "failed", errorCode: "automation_run_duration_exceeded" });
  expect((await f.transactions.get("run"))?.nodes[0]).toMatchObject({
    status: "succeeded", resultRef: "result",
  });
  expect(f.calls).toEqual(["active"]);
});

test.each(["stop", "skip"] as const)("last-node cancellation cannot succeed with onFailure=%s", async (onFailure) => {
  const f = fixture(onFailure, ["active"]);
  const running = f.run(async (signal) => {
    await observeAbort(signal);
    return { status: "cancelled", errorCode: "automation_run_stopped" };
  });
  await vi.advanceTimersByTimeAsync(1);
  f.abort.abort(new Error("automation_run_stopped"));
  expect(await running).toMatchObject({ status: "cancelled" });
  expect((await f.transactions.get("run"))?.nodes)
    .toMatchObject([{ nodeId: "active", status: "cancelled", errorCode: "automation_run_stopped" }]);
});
