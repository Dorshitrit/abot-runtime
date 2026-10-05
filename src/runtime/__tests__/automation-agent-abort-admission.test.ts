import { afterEach, expect, test, vi } from "vitest";
import type { AutomationJournalState } from "../automations/storage-records.js";
import { createSchedulerRuntimeFixture, createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";
import { addAgent, operation, probeTools, scriptToolUsingAgent } from "./support/automation-agent-tool-fixture.js";

const admission = vi.hoisted(() => ({
  afterCommit: undefined as (() => Promise<void>) | undefined,
  read: undefined as (() => Promise<AutomationJournalState>) | undefined,
}));

vi.mock("../automations/node-transactions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../automations/node-transactions.js")>();
  return { ...actual, createAutomationNodeTransactions: (
    options: Parameters<typeof actual.createAutomationNodeTransactions>[0],
  ) => {
    const transactions = actual.createAutomationNodeTransactions(options);
    admission.read = options.persistence.read;
    return { ...transactions, recordAgentAttempt: async (
      input: Parameters<typeof transactions.recordAgentAttempt>[0],
    ) => {
      const record = await transactions.recordAgentAttempt(input);
      await admission.afterCommit?.();
      return record;
    } };
  } };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  admission.afterCommit = undefined;
  admission.read = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s settles an admitted but undispatched effect before cancelling the graph",
  async (policy) => {
    const tools = probeTools("mutating");
    const f = await createSchedulerRuntimeFixture(policy, undefined, tools.registry);
    cleanups.push(f.dispose);
    scriptToolUsingAgent(f, policy);
    const entered = createSchedulerTestGate();
    const resume = createSchedulerTestGate();
    cleanups.push(async () => { resume.open(); });
    admission.afterCommit = async () => {
      entered.open();
      await resume.waiting;
    };
    const studio = f.application.services.automations!;
    let draft = await studio.create("Stop before Tool dispatch");
    draft = await addAgent(studio, draft, "Admitted agent");
    const nodeId = draft.definition.body.children[0]!.id;
    await studio.replaceGrant({ automationId: draft.automationId, expectedGrantRevision: 0,
      mode: "full_access", operations: [operation], actionId: "test-grant" });
    await studio.publish(draft.automationId, draft.revision);
    const run = await studio.runNow(draft.automationId);
    await entered.waiting;
    expect((await admission.read!()).attempts).toMatchObject([{ state: "started" }]);
    expect(tools.execute).not.toHaveBeenCalled();
    await studio.stopRun(run.id);
    resume.open();

    await expect.poll(async () => {
      const status = (await studio.getRun(run.id)).status;
      return ["pending", "running", "stopping"].includes(status) ? "active" : status;
    }, { timeout: 5_000, interval: 10 }).not.toBe("active");
    const completed = await studio.getRun(run.id);
    expect(completed.status).toBe("cancelled");
    expect(completed.report?.effectSummary).toMatchObject({
      total: 1, unresolvedAttempts: 0, verifiedExecutions: 0,
      entries: [{ nodeId, operation, outcome: "rejected", errorCode: "request_aborted" }],
    });
    const state = await admission.read!();
    expect(state.attempts).toMatchObject([{
      nodeId, state: "settled", settlementRef: expect.any(String),
    }]);
    expect(state.executions.find((item) => item.id === run.id)?.nodes)
      .toMatchObject([{ nodeId, status: "cancelled", errorCode: "automation_run_stopped" }]);
    expect(state.results.find((item) => item.id === state.attempts[0]?.settlementRef))
      .toMatchObject({ runId: run.id, nodeId, kind: "effect_receipt" });
    const evidence = await studio.getStepEvidence(run.id, nodeId, true);
    expect(evidence).toMatchObject({ stepStatus: "cancelled",
      effects: [{ operation, outcome: "rejected", errorCode: "request_aborted" }] });
    expect(tools.execute).not.toHaveBeenCalled();
    const modelSteps = f.invoke.mock.calls.map(([input]) => input.modelStep);
    expect(modelSteps).toContain(policy === "execution-agent-v1" ? "execution.decision" : "worker.decision");
    if (policy === "supervisor-worker-v1") expect(modelSteps).toContain("capability.controls");
    expect(modelSteps).not.toContain("execution.response");
    expect(modelSteps).not.toContain("supervisor.response");
  },
  10_000,
);
