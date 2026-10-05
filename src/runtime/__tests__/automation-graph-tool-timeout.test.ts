import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { executeToolCall } from "../../capabilities/tool-executor.js";
import type { RegisteredToolNormalInvocation, ToolImplementationOutput } from "../../capabilities/tool-types.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import type { AutomationRevision } from "../automations/definition-contracts.js";
import { executeAutomationGraph } from "../automations/graph-executor.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import { createAutomationNodeTransactions } from "../automations/node-transactions.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { createAutomationResultStore } from "../automations/result-store.js";
import { createAutomationStepRunner } from "../automations/step-runner.js";
import { emptyAutomationJournalState, type AutomationGrantRecord } from "../automations/storage-records.js";
import { createAutomationToolLifetimes } from "../automations/tool-lifetimes.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(effect: "read_only" | "mutating" | "mixed", onFailure: "stop" | "skip" = "skip",
  settlement: "abort_race" | "adapter_receipt" = "abort_race") {
  const root = await mkdtemp(join(tmpdir(), "automation-graph-tool-timeout-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
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
  const operation = { toolName: "bounded_tool", operationId: "invoke", contractVersion: 1 };
  const registration: RegisteredToolNormalInvocation = {
    toolName: operation.toolName,
    definition: { name: operation.toolName, routingCapability: "semantic_lookup",
      executionEffect: effect, params: {} },
    contract: { version: 1, operations: [{ operationId: operation.operationId,
      summary: "Perform a bounded operation", effect, approval: "request_policy",
      input: { type: "object", additionalProperties: false, properties: {}, required: [] },
    }] },
  };
  const started = deferred<void>();
  const underlying = deferred<ToolImplementationOutput>();
  const implementation = vi.fn(async () => {
    started.resolve();
    return underlying.promise;
  });
  const implementations = { [operation.toolName]: implementation };
  const tools: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: () => registration.definition,
    getImplementations: () => implementations,
    hasToolsAvailable: () => true,
    execute: (call, options) => {
      // An adapter receipt may win the public abort race. Keep that exact
      // result to exercise the durable automation consumer deterministically.
      if (settlement === "adapter_receipt")
        return implementation().then((output) => ({ tool: operation.toolName, ...output }));
      return executeToolCall(call, {
        implementations, abortSignal: options?.abortSignal,
        sharedState: options?.sharedState,
        onUnderlyingSettlement: options?.onUnderlyingSettlement,
      });
    },
  };
  const grant: AutomationGrantRecord = {
    id: "grant", automationId: "automation", environmentId: "dev", grantRevision: 1,
    mode: "full_access", operations: [operation],
    evidence: { kind: "authenticated_user_action", actionId: "grant-action",
      at: "2026-09-29T10:00:00Z" },
  };
  const definition: AutomationRevision = {
    schemaVersion: 1, automationId: "automation", revision: 1,
    title: "Bounded operations", objective: "Preserve timeout evidence",
    trigger: { kind: "manual" }, inputs: {},
    limits: { ...DEFAULT_AUTOMATION_LIMITS, maxRunDurationMs: 20, stopReportDeadlineMs: 10 },
    body: { kind: "sequence", id: "root", children: ["active", "pending"].map((id) => ({
      kind: "tool", id, title: id, onFailure, operation, controls: {},
    })) },
  };
  const compiled = compileAutomationGraph(definition);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const transactions = createAutomationNodeTransactions({ persistence });
  const results = createAutomationResultStore(root);
  const lifetimes = createAutomationToolLifetimes();
  const runner = createAutomationStepRunner({
    runId: "run", automationId: "automation", definition, graph: compiled.graph,
    config: { runtimeId: "dev", paths: { agentWorkDir: root } } as RuntimeConfig,
    tools, attachments: createFileAttachmentStore({ attachmentsDir: join(root, "attachments") }),
    persistence, results, transactions, toolLifetimes: lifetimes,
    grants: { get: async () => grant },
  });
  const run = (abortSignal?: AbortSignal) => executeAutomationGraph({
    runId: "run", automationId: "automation", definition, inputIds: [],
    graph: compiled.graph, transactions, executeStep: runner.run, abortSignal,
  });
  return { run, started, underlying, implementation, persistence, results, lifetimes };
}

test.each([
  { effect: "read_only", nodeStatus: "skipped", attemptState: "settled", errorCode: "request_aborted" },
  { effect: "mutating", nodeStatus: "failed", attemptState: "uncertain", errorCode: "automation_effect_uncertain" },
] as const)("$effect tool timeout keeps durable receipts and fails the graph", async (expected) => {
  const f = await fixture(expected.effect);
  vi.useFakeTimers();
  const running = f.run();
  await f.started.promise;
  await vi.advanceTimersByTimeAsync(21);
  const outcome = await running;
  expect(outcome).toMatchObject({ status: "failed", errorCode: "automation_run_duration_exceeded" });
  expect(outcome.nodeResults.get("active")).toMatchObject({
    status: expected.nodeStatus, errorCode: expected.errorCode,
  });
  const state = await f.persistence.read();
  expect(state.executions[0]?.nodes).toMatchObject([
    { nodeId: "active", status: expected.nodeStatus, errorCode: expected.errorCode,
      resultRef: expect.any(String), attemptId: expect.any(String) },
    { nodeId: "pending", status: "failed", errorCode: "automation_run_duration_exceeded" },
  ]);
  expect(state.attempts).toHaveLength(1);
  expect(state.attempts[0]).toMatchObject({ state: expected.attemptState, settlementRef: expect.any(String) });
  expect(state.results).toHaveLength(1);
  expect(state.results[0]?.id).toBe(state.attempts[0]?.settlementRef);
  const value = await f.results.read(state.results[0]!);
  if (expected.effect === "read_only") {
    expect(value).toMatchObject({ receipt: { ok: false, effect: "read_only", errorCode: "request_aborted" } });
  } else {
    expect(value).toMatchObject({ kind: "uncertain", code: "automation_effect_uncertain" });
    expect(outcome.nodeResults.get("active")?.uncertain).toBe(true);
  }
  expect(f.implementation).toHaveBeenCalledOnce();

  let drained = false;
  const drain = f.lifetimes.whenSettled("run").then((observed) => { drained = true; return observed; });
  await Promise.resolve();
  expect(drained).toBe(false);
  f.underlying.resolve({ ok: true, output: "Late operation result", producedNewInformation: true });
  expect(await drain).toEqual([{
    invocationId: state.attempts[0]!.invocationId, settlement: { status: "fulfilled", ok: true },
  }]);
  expect((await f.persistence.read()).attempts[0]?.state).toBe(expected.attemptState);
  expect(f.implementation).toHaveBeenCalledOnce();
});

test.each([
  { effect: "read_only", onFailure: "stop", stopped: true, interruption: true, code: "web_request_aborted", status: "cancelled" },
  { effect: "read_only", onFailure: "skip", stopped: true, interruption: true, code: "adapter_cancelled", status: "cancelled" },
  { effect: "read_only", onFailure: "stop", stopped: true, interruption: false, code: "upstream_failed", status: "failed" },
  { effect: "read_only", onFailure: "stop", stopped: true, interruption: false, code: "arbitrary_aborted", status: "failed" },
  { effect: "read_only", onFailure: "stop", stopped: false, interruption: true, code: "adapter_cancelled", status: "failed" },
  { effect: "mutating", onFailure: "skip", stopped: true, interruption: true, code: "adapter_cancelled", status: "failed" },
  { effect: "mixed", onFailure: "stop", stopped: true, interruption: true, code: "adapter_cancelled", status: "failed" },
] as const)("durable adapter receipt: $effect/$onFailure/$code, stopped=$stopped", async (expected) => {
  const f = await fixture(expected.effect, expected.onFailure, "adapter_receipt");
  vi.useFakeTimers();
  const abort = new AbortController();
  const running = f.run(abort.signal);
  await f.started.promise;
  if (expected.stopped) abort.abort(new Error("automation_run_stopped"));
  f.underlying.resolve({ ok: false, output: "Bounded adapter failure", producedNewInformation: false,
    errorCode: expected.code, ...(expected.interruption ? { interruption: "aborted" } : {}) });
  const outcome = await running;
  expect(outcome.status).toBe(expected.status);
  expect(outcome.nodeResults.get("active")?.status).toBe(expected.status);
  const state = await f.persistence.read();
  expect(state.executions[0]?.nodes[0]).toMatchObject({ status: expected.status, resultRef: expect.any(String) });
  expect(state.attempts).toHaveLength(1);
  const uncertain = expected.effect !== "read_only";
  expect(state.attempts[0]?.state).toBe(uncertain ? "uncertain" : "settled");
  const saved = await f.results.read(state.results[0]!);
  if (uncertain) {
    expect(saved).toMatchObject({ kind: "uncertain", code: "automation_effect_uncertain" });
    expect(outcome.nodeResults.get("active")?.uncertain).toBe(true);
  } else {
    expect(saved).toMatchObject({ receipt: { ok: false, errorCode: expected.code,
      ...(expected.interruption ? { interruption: "aborted" } : {}) } });
  }
  expect(f.implementation).toHaveBeenCalledOnce();
});

test.each([
  { effect: "read_only", onFailure: "stop", status: "cancelled", attemptState: "settled" },
  { effect: "read_only", onFailure: "skip", status: "cancelled", attemptState: "settled" },
  { effect: "mutating", onFailure: "stop", status: "failed", attemptState: "uncertain" },
  { effect: "mutating", onFailure: "skip", status: "failed", attemptState: "uncertain" },
] as const)("user stop preserves $effect receipts with onFailure=$onFailure", async (expected) => {
  const f = await fixture(expected.effect, expected.onFailure);
  vi.useFakeTimers();
  const abort = new AbortController();
  const running = f.run(abort.signal);
  await f.started.promise;
  abort.abort(new Error("automation_run_stopped"));
  await vi.advanceTimersByTimeAsync(25);
  const outcome = await running;
  expect(outcome.status).toBe(expected.status);
  const errorCode = expected.effect === "read_only" ? "automation_run_stopped" : "automation_effect_uncertain";
  expect(outcome.nodeResults.get("active")).toMatchObject({ status: expected.status, errorCode });
  const state = await f.persistence.read();
  expect(state.executions[0]?.nodes).toMatchObject([
    { nodeId: "active", status: expected.status, errorCode, resultRef: expect.any(String) },
    { nodeId: "pending", status: "cancelled", errorCode: "automation_run_stopped" },
  ]);
  expect(state.attempts[0]).toMatchObject({ state: expected.attemptState, settlementRef: expect.any(String) });
  expect(state.results).toHaveLength(1);
  if (expected.effect === "read_only") {
    expect(await f.results.read(state.results[0]!)).toMatchObject({
      receipt: { ok: false, effect: "read_only", errorCode: "request_aborted" },
    });
  }
  f.underlying.resolve({ ok: true, output: "Late result", producedNewInformation: true });
  await f.lifetimes.whenSettled("run");
  expect(f.implementation).toHaveBeenCalledOnce();
});
