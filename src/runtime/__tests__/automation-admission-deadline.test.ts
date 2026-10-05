import { afterEach, expect, test, vi } from "vitest";
import type { AutomationJournalState } from "../automations/storage-records.js";
import type { SchedulerAutomationStartedRun } from "../scheduler/contracts.js";
import { createSchedulerRuntimeFixture, createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";
import { addAgent, operation, probeTools, scriptToolUsingAgent } from "./support/automation-agent-tool-fixture.js";

const admission = vi.hoisted(() => ({
  afterCommit: undefined as (() => Promise<void>) | undefined,
  read: undefined as (() => Promise<AutomationJournalState>) | undefined,
  started: new Map<string, SchedulerAutomationStartedRun>(),
  actual: [] as Promise<void>[],
}));

vi.mock("../automations/node-transactions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../automations/node-transactions.js")>();
  return { ...actual, createAutomationNodeTransactions: (
    options: Parameters<typeof actual.createAutomationNodeTransactions>[0],
  ) => {
    const transactions = actual.createAutomationNodeTransactions(options);
    admission.read = options.persistence.read;
    return { ...transactions,
      recordAttempt: async (input: Parameters<typeof transactions.recordAttempt>[0]) => {
        const record = await transactions.recordAttempt(input);
        await admission.afterCommit?.();
        return record;
      },
      recordAgentAttempt: async (input: Parameters<typeof transactions.recordAgentAttempt>[0]) => {
        const record = await transactions.recordAgentAttempt(input);
        await admission.afterCommit?.();
        return record;
      },
    };
  } };
});

vi.mock("../automations/runtime-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../automations/runtime-executor.js")>();
  return { ...actual, createAutomationRuntimeExecutor: (
    options: Parameters<typeof actual.createAutomationRuntimeExecutor>[0],
  ) => {
    const executor = actual.createAutomationRuntimeExecutor({ ...options, execute: (...args) => {
      const executing = options.execute(...args);
      admission.actual.push(executing.then(() => undefined, () => undefined));
      return executing;
    } });
    return { ...executor, start: (
      ...args: Parameters<typeof executor.start>
    ) => {
      const started = executor.start(...args);
      admission.started.set(args[1].id, started);
      return started;
    } };
  } };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  admission.afterCommit = undefined;
  admission.read = undefined;
  admission.started.clear();
  admission.actual.length = 0;
});

const cases = ["tool", "execution-agent-v1", "supervisor-worker-v1"].flatMap((path) =>
  ["stop", "budget"].map((deadline) => ({ path, deadline })));

test.each(cases)("$path retains admission beyond the $deadline deadline until its rejection is durable", async ({ path, deadline }) => {
  const policy = path === "supervisor-worker-v1" ? path : "execution-agent-v1";
  const tools = probeTools("mutating");
  const f = await createSchedulerRuntimeFixture(policy, undefined, tools.registry);
  cleanups.push(f.dispose);
  scriptToolUsingAgent(f, policy);
  const entered = createSchedulerTestGate();
  const resume = createSchedulerTestGate();
  admission.afterCommit = async () => {
    entered.open();
    await resume.waiting;
  };
  cleanups.push(async () => {
    resume.open();
    await Promise.all([...admission.started.values()].map((started) => started.resourcesSettled));
    await Promise.all(admission.actual);
  });
  const studio = f.application.services.automations!;
  let draft = await studio.create("Admission deadline race");
  draft = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_definition", patch: { limits: { ...draft.definition.limits,
      maxRunDurationMs: 1000, stopReportDeadlineMs: 10 } },
  });
  if (path === "tool") {
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "add_node", parentSequenceId: draft.definition.body.id, index: 0,
      nodeWithoutId: { kind: "tool", title: "Direct operation", onFailure: "stop",
        operation, controls: {} },
    });
  } else {
    draft = await addAgent(studio, draft, "Agent operation");
  }
  const nodeId = draft.definition.body.children[0]!.id;
  await studio.replaceGrant({ automationId: draft.automationId, expectedGrantRevision: 0,
    mode: "full_access", operations: [operation], actionId: "test-grant" });
  await studio.publish(draft.automationId, draft.revision);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const run = await studio.runNow(draft.automationId);
  await entered.waiting;
  const started = admission.started.get(run.id)!;
  let resourcesReleased = false;
  void started.resourcesSettled.then(() => { resourcesReleased = true; });
  if (deadline === "stop") await studio.stopRun(run.id);
  await vi.advanceTimersByTimeAsync(deadline === "stop" ? 11 : 1011);
  vi.useRealTimers();
  const outcome = await started.outcome;
  const expectedStatus = deadline === "stop" ? "cancelled" : "failed";
  expect(outcome.status).toBe(expectedStatus);
  await expect.poll(async () => (await studio.getRun(run.id)).status,
    { timeout: 5000, interval: 10 }).toBe(expectedStatus);
  const terminal = await admission.read!();
  const terminalExecution = terminal.executions.find((item) => item.id === run.id)!;
  expect(terminal.attempts).toMatchObject([{ nodeId, state: "uncertain" }]);
  expect(resourcesReleased).toBe(false);
  expect(tools.execute).not.toHaveBeenCalled();

  resume.open();
  await started.resourcesSettled;
  const state = await admission.read!();
  expect(resourcesReleased).toBe(true);
  expect(tools.execute).not.toHaveBeenCalled();
  expect(state.attempts).toMatchObject([{ nodeId, state: "settled", settlementRef: expect.any(String) }]);
  expect(state.executions.find((item) => item.id === run.id)).toMatchObject({
    reportRef: terminalExecution.reportRef,
    terminalAt: terminalExecution.terminalAt,
    nodes: terminalExecution.nodes,
  });
  expect(await studio.getRun(run.id)).toMatchObject({ status: expectedStatus,
    report: { effectSummary: { total: 1, unresolvedAttempts: 0, verifiedExecutions: 0 } } });
  expect((await studio.getStepEvidence(run.id, nodeId, true)).effects)
    .toMatchObject([{ outcome: "rejected", errorCode: "request_aborted" }]);
}, 10_000);
