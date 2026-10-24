import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createRoleCallLedger, SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger, type RoleMemoryRecallResult,
} from "../orchestration/role-calls/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { canRecallSupervisorMemory, projectSupervisorProcedureEntry } from "../steps/supervisor-decision/procedure-entry.js";
import { MEMORY_RECORD } from "./support/memory-recall-runner.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

async function fixture() {
  const ledger = createRoleCallLedger({
    requestId: "procedure-entry",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      limits: { maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 16,
        maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536 },
    },
  });
  const result = await ledger.transactions!.createRoot({ expectedHead: ledger.current() });
  if (!result.ok) throw new Error(result.issueCode);
  return ledger;
}

function options(ledger: RoleCallLedger) {
  const head = ledger.current();
  const root = head.state.calls.find(call => call.callId === head.state.rootCallId)!;
  return {
    skillReadHead: head,
    call: { rootCallId: root.callId, callId: root.callId, parentCallId: null,
      depth: 0, invocationAttempt: root.activationCount },
    toolResults: { sourceRevision: 0, results: [] },
  };
}

async function recall(ledger: RoleCallLedger, result: RoleMemoryRecallResult, steeringVersion = 0) {
  const current = options(ledger);
  const identity = { callId: current.call.callId,
    invocationAttempt: current.call.invocationAttempt, steeringVersion };
  const started = await ledger.transactions!.beginMemoryRecall({
    ...identity, expectedHead: ledger.current(), query: "saved preference",
  });
  if (!started.ok) throw new Error(started.issueCode);
  const settled = await ledger.transactions!.settleMemoryRecall({
    ...identity, expectedHead: ledger.current(), recallId: started.commit.effect.recallId, result,
  });
  if (!settled.ok) throw new Error(settled.issueCode);
}

test("canonical fresh root offers an initial lookup, subject to the existing global policy", async () => {
  const entry = projectSupervisorProcedureEntry(options(await fixture()), 0);
  expect(entry).toEqual({ classifyProcedure: true, allowInitialMemoryRecall: true, memoryRecallMessage: undefined });
  expect(canRecallSupervisorMemory(entry, { enabled: true, recallCount: 0, maxRecallCallsPerRequest: 1 })).toBe(true);
  expect(canRecallSupervisorMemory(entry, { enabled: true, recallCount: 1, maxRecallCallsPerRequest: 1 })).toBe(false);
  expect(canRecallSupervisorMemory(entry, { enabled: false, recallCount: 0 })).toBe(false);
});

test.each(["found", "empty", "unavailable"] as const)(
  "canonical %s receipt regenerates omitted caller context and prevents repeated initial lookup", async outcome => {
    const ledger = await fixture();
    await recall(ledger, { outcome, records: outcome === "found" ? [MEMORY_RECORD] : [], omittedRecordCount: 0 });
    const entry = projectSupervisorProcedureEntry(options(ledger), 0);
    expect(entry.classifyProcedure).toBe(true);
    expect(entry.allowInitialMemoryRecall).toBe(false);
    expect(canRecallSupervisorMemory(entry, { enabled: true, recallCount: 1, maxRecallCallsPerRequest: 5 })).toBe(false);
    expect(JSON.parse(entry.memoryRecallMessage!.content)).toMatchObject({
      callId: "call-1", steeringVersion: 0, recalls: [{ outcome }],
    });
  },
);

test("an omitted superseded receipt cannot reopen recall for the same intent", async () => {
  const ledger = await fixture();
  await recall(ledger, { outcome: "superseded", records: [], omittedRecordCount: 0 });
  expect(projectSupervisorProcedureEntry(options(ledger), 0)).toEqual({
    classifyProcedure: true, allowInitialMemoryRecall: false, memoryRecallMessage: undefined,
  });
  const fresh = projectSupervisorProcedureEntry(options(ledger), 1);
  expect(fresh).toEqual({ classifyProcedure: true, allowInitialMemoryRecall: true, memoryRecallMessage: undefined });
  expect(canRecallSupervisorMemory(fresh, { enabled: true, recallCount: 1, maxRecallCallsPerRequest: 1 })).toBe(false);
});

test.each(["completed", "failed"] as const)("a %s child keeps continuation routing even without a resume or tool receipt", async outcome => {
  const ledger = await fixture();
  const opened = await ledger.transactions!.openChild({
    expectedHead: ledger.current(), callerCallId: "call-1", roleId: "worker", objective: "Observe current state.",
  });
  if (!opened.ok) throw new Error(opened.issueCode);
  expect(projectSupervisorProcedureEntry(options(ledger), 0).classifyProcedure).toBe(false);
  const returned = await ledger.transactions!.returnChild({
    expectedHead: ledger.current(), callerCallId: "call-1", childCallId: opened.commit.effect.childCallId,
    outcome, summary: "Bounded observation result.",
  });
  if (!returned.ok) throw new Error(returned.issueCode);
  const entry = projectSupervisorProcedureEntry(options(ledger), 0);
  expect(entry.classifyProcedure).toBe(false);
  expect(canRecallSupervisorMemory(entry, { enabled: true, recallCount: 0 })).toBe(true);
});

test("new initial recall requires the canonical current root invocation", async () => {
  const current = options(await fixture());
  for (const call of [
    { ...current.call, callId: "unrelated-call" },
    { ...current.call, invocationAttempt: current.call.invocationAttempt + 1 },
  ]) expect(projectSupervisorProcedureEntry({ ...current, call }, 0).classifyProcedure).toBe(false);
  expect(projectSupervisorProcedureEntry({ ...current, skillReadHead: undefined }, 0)).toEqual({
    classifyProcedure: true, allowInitialMemoryRecall: false, memoryRecallMessage: undefined,
  });
  expect(projectSupervisorProcedureEntry({ ...current, allowedRoleIds: [] }, 0).classifyProcedure).toBe(false);
});
