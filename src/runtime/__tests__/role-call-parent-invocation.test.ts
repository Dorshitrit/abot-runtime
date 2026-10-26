import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createRoleCallLedger,
  validateRoleCallCandidate,
  type RoleCallLedger,
  type RoleCallPolicyInput,
} from "../orchestration/role-calls/index.js";
import {
  captureRoleCallLedgerCheckpoint,
  restoreRoleCallLedgerCheckpoint,
  type RoleCallLedgerCheckpoint,
} from "../orchestration/role-calls/checkpoint.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const requestId = "parent-invocation-continuity";
const policy: RoleCallPolicyInput = {
  limits: {
    maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 16,
    maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536,
  },
};

async function rootedLedger() {
  const ledger = createRoleCallLedger({ requestId, policy });
  const created = await ledger.transactions!.createRoot({ expectedHead: ledger.current() });
  if (!created.ok) throw new Error(created.issueCode);
  return ledger;
}

async function openWorker(ledger: RoleCallLedger) {
  const opened = await ledger.transactions!.openChild({
    expectedHead: ledger.current(), callerCallId: "call-1",
    roleId: "worker", objective: "Observe the selected target.",
  });
  if (!opened.ok) throw new Error(opened.issueCode);
  return opened.commit.effect.childCallId;
}

async function returnWorker(
  ledger: RoleCallLedger,
  childCallId: string,
  outcome: "completed" | "failed" = "completed",
) {
  const returned = await ledger.transactions!.returnChild({
    expectedHead: ledger.current(), callerCallId: "call-1", childCallId,
    outcome, summary: "The bounded observation returned.",
  });
  if (!returned.ok) throw new Error(returned.issueCode);
}

async function parkCapability(ledger: RoleCallLedger, callId: string) {
  const call = ledger.current().state.calls.find((entry) => entry.callId === callId)!;
  const parked = await ledger.transactions!.beginCapabilityExecution({
    expectedHead: ledger.current(), callId, invocationAttempt: call.activationCount,
    capabilityId: "example.observe", declaredEffect: "observation",
    intent: "Observe the selected target.", controlsJson: "{}",
  });
  if (!parked.ok) throw new Error(parked.issueCode);
}

async function parkedCheckpoint() {
  const ledger = await rootedLedger();
  await returnWorker(ledger, await openWorker(ledger));
  await parkCapability(ledger, await openWorker(ledger));
  return JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(ledger))) as RoleCallLedgerCheckpoint;
}

function withParentAttempt(
  checkpoint: RoleCallLedgerCheckpoint,
  callId: string,
  value: unknown,
): RoleCallLedgerCheckpoint {
  return {
    ...checkpoint,
    state: { ...checkpoint.state, calls: checkpoint.state.calls.map((call) =>
      call.callId === callId ? { ...call, parentInvocationAttempt: value as number } : call,
    ) },
  };
}

test("stamps each accepted child opening and preserves it through returns and later activations", async () => {
  const ledger = await rootedLedger();
  expect(ledger.current().state.calls[0]).not.toHaveProperty("parentInvocationAttempt");
  const firstId = await openWorker(ledger);
  const openedFirst = ledger.current().state.calls.find((call) => call.callId === firstId)!;
  expect(openedFirst.parentInvocationAttempt).toBe(1);
  expect(Object.isFrozen(openedFirst)).toBe(true);
  await returnWorker(ledger, firstId);
  const secondId = await openWorker(ledger);
  await returnWorker(ledger, secondId, "failed");
  const { state, policy: sealedPolicy } = ledger.current();
  expect(state.calls.slice(1).map((call) => call.parentInvocationAttempt)).toEqual([1, 2]);
  expect(state.calls[0]!.activationCount).toBe(3);
  expect(openedFirst).toMatchObject({ parentInvocationAttempt: 1, status: "active" });
  expect(validateRoleCallCandidate({ state, policy: sealedPolicy })).toEqual([]);
});

test("restores exact metadata for completed and parked child calls", async () => {
  const checkpoint = await parkedCheckpoint();
  const restored = restoreRoleCallLedgerCheckpoint(checkpoint, { requestId, policy });
  expect(restored.current().state.calls.map((call) => call.parentInvocationAttempt))
    .toEqual([undefined, 1, 2]);
  expect(restored.current().state).toEqual(checkpoint.state);
});

test("accepts legacy snapshots without inventing parent opening positions", async () => {
  const checkpoint = await parkedCheckpoint();
  const legacy = {
    ...checkpoint,
    state: { ...checkpoint.state, calls: checkpoint.state.calls.map((call) => {
      const { parentInvocationAttempt: _omitted, ...legacyCall } = call;
      return legacyCall;
    }) },
  };
  const restored = restoreRoleCallLedgerCheckpoint(legacy, { requestId, policy });
  for (const call of restored.current().state.calls) {
    expect(Object.hasOwn(call, "parentInvocationAttempt")).toBe(false);
  }
});

test.each([undefined, null, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"])(
  "rejects a provided invalid opening activation %s on snapshot restore",
  async (value) => {
    const checkpoint = withParentAttempt(await parkedCheckpoint(), "call-3", value);
    expect(() => restoreRoleCallLedgerCheckpoint(checkpoint, { requestId, policy }))
      .toThrow("role_call_checkpoint_state_invalid");
  },
);

test.each([
  ["root has no parent opening", "call-1", 1],
  ["completed child must precede the resumed parent", "call-2", 2],
  ["child cannot open in a future parent activation", "call-3", 3],
  ["siblings cannot share one parent activation", "call-3", 1],
] as const)("rejects invalid chronology: %s", async (_description, callId, value) => {
  const checkpoint = withParentAttempt(await parkedCheckpoint(), callId, value);
  expect(() => restoreRoleCallLedgerCheckpoint(checkpoint, { requestId, policy }))
    .toThrow("role_call_checkpoint_state_invalid");
});

test("rejects a recorded parent activation without exact parent-child linkage", async () => {
  const checkpoint = await parkedCheckpoint();
  const unlinked = {
    ...checkpoint,
    state: { ...checkpoint.state, calls: checkpoint.state.calls.map((call) =>
      call.callId === "call-1" ? { ...call, childCallIds: ["call-2"] } : call,
    ) },
  };
  expect(() => restoreRoleCallLedgerCheckpoint(unlinked, { requestId, policy }))
    .toThrow("role_call_checkpoint_state_invalid");
});

test("scopes opening activation uniqueness to the exact parent", async () => {
  const ledger = await rootedLedger();
  const opened = await ledger.transactions!.openChild({
    expectedHead: ledger.current(), callerCallId: "call-1", roleId: "planner",
    objective: "Coordinate the observation.",
  });
  if (!opened.ok) throw new Error(opened.issueCode);
  const nested = await ledger.transactions!.openChild({
    expectedHead: ledger.current(), callerCallId: "call-2", roleId: "worker",
    objective: "Observe the selected target.",
    plannerPlan: {
      mode: "declare", selectedItemIndexes: [0],
      plan: { summary: "One bounded observation.", items: [
        { title: "Observe", objective: "Observe the selected target." },
      ] },
    },
  });
  if (!nested.ok) throw new Error(nested.issueCode);
  await parkCapability(ledger, "call-3");
  const checkpoint = captureRoleCallLedgerCheckpoint(ledger);
  const restored = restoreRoleCallLedgerCheckpoint(checkpoint, { requestId, policy });
  expect(restored.current().state.calls.slice(1).map((call) => call.parentInvocationAttempt))
    .toEqual([1, 1]);
});
