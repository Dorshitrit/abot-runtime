import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createRoleCallLedger,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
  type RoleMemoryRecallResult,
} from "../orchestration/role-calls/index.js";
import { validateRoleMemoryRecalls } from "../orchestration/role-calls/memory-recall-state-validation.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const empty: RoleMemoryRecallResult = {
  outcome: "empty",
  records: [],
  omittedRecordCount: 0,
};

async function rootedLedger() {
  const ledger = createRoleCallLedger({
    requestId: "recall-child-order",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: 8192,
        maxResultChars: 8192,
        maxResponseChars: 65536,
      },
    },
  });
  const created = await ledger.transactions!.createRoot({
    expectedHead: ledger.current(),
  });
  if (!created.ok) throw new Error(created.issueCode);
  return ledger;
}

async function begin(ledger: RoleCallLedger) {
  const head = ledger.current();
  const call = head.state.calls.find(
    ({ callId }) => callId === head.state.rootCallId,
  )!;
  const binding = {
    callId: call.callId,
    invocationAttempt: call.activationCount,
    steeringVersion: 0,
  };
  const started = await ledger.transactions!.beginMemoryRecall({
    ...binding,
    expectedHead: head,
    query: "Stored preference",
  });
  if (!started.ok) throw new Error(started.issueCode);
  return {
    ...binding,
    expectedHead: started.commit.head,
    recallId: started.commit.effect.recallId,
  };
}

async function settle(
  ledger: RoleCallLedger,
  binding: Awaited<ReturnType<typeof begin>>,
) {
  const settled = await ledger.transactions!.settleMemoryRecall({
    ...binding,
    result: empty,
  });
  if (!settled.ok) throw new Error(settled.issueCode);
}

async function returnChild(ledger: RoleCallLedger) {
  const opened = await ledger.transactions!.openChild({
    expectedHead: ledger.current(),
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Perform one bounded observation.",
  });
  if (!opened.ok) throw new Error(opened.issueCode);
  const returned = await ledger.transactions!.returnChild({
    expectedHead: ledger.current(),
    callerCallId: "call-1",
    childCallId: opened.commit.effect.childCallId,
    outcome: "completed",
    summary: "The observation completed.",
  });
  if (!returned.ok) throw new Error(returned.issueCode);
}

test("captures completed-child position before and after returns without rewriting old receipts", async () => {
  const ledger = await rootedLedger();
  const first = await begin(ledger);
  expect(ledger.current().state.memoryRecalls[0]).toMatchObject({
    status: "pending",
    completedChildCount: 0,
  });
  await settle(ledger, first);
  const originalFirst = ledger.current().state.memoryRecalls[0];
  expect(Object.isFrozen(originalFirst)).toBe(true);
  await returnChild(ledger);
  const second = await begin(ledger);
  expect(ledger.current().state.memoryRecalls[1]).toMatchObject({
    status: "pending",
    completedChildCount: 1,
  });
  await settle(ledger, second);
  const originalSecond = ledger.current().state.memoryRecalls[1];
  await returnChild(ledger);
  expect(ledger.current().state.memoryRecalls).toEqual([
    originalFirst,
    originalSecond,
  ]);
  const third = await begin(ledger);
  expect(ledger.current().state.memoryRecalls[2]).toMatchObject({
    status: "pending",
    completedChildCount: 2,
  });
  await settle(ledger, third);
  expect(
    ledger
      .current()
      .state.memoryRecalls.map(
        ({ completedChildCount }) => completedChildCount,
      ),
  ).toEqual([0, 1, 2]);
  expect(validateRoleMemoryRecalls(ledger.current().state)).toEqual([]);
});

test.each([
  undefined,
  null,
  -1,
  0.5,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  2,
])(
  "rejects an invalid completed-child anchor %s",
  async (completedChildCount) => {
    const ledger = await rootedLedger();
    await returnChild(ledger);
    const started = await begin(ledger);
    await settle(ledger, started);
    const state = ledger.current().state;
    const altered = {
      ...state,
      memoryRecalls: state.memoryRecalls.map((recall) => ({
        ...recall,
        completedChildCount: completedChildCount as number,
      })),
    };
    expect(validateRoleMemoryRecalls(altered)).toEqual([
      { code: "invalid_role_memory_recalls", path: "state.memoryRecalls" },
    ]);
  },
);

test("requires a pending recall to retain the active root's exact completed-child position", async () => {
  const ledger = await rootedLedger();
  await returnChild(ledger);
  await begin(ledger);
  const state = ledger.current().state;
  expect(validateRoleMemoryRecalls(state)).toEqual([]);
  expect(
    validateRoleMemoryRecalls({
      ...state,
      memoryRecalls: state.memoryRecalls.map((recall) => ({
        ...recall,
        completedChildCount: 0,
      })),
    }),
  ).toHaveLength(1);
});

test("rejects regressing anchors across settled recalls", async () => {
  const ledger = await rootedLedger();
  await returnChild(ledger);
  await settle(ledger, await begin(ledger));
  await returnChild(ledger);
  await settle(ledger, await begin(ledger));
  const state = ledger.current().state;
  expect(validateRoleMemoryRecalls(state)).toEqual([]);
  expect(
    validateRoleMemoryRecalls({
      ...state,
      memoryRecalls: state.memoryRecalls.map((recall, index) => ({
        ...recall,
        completedChildCount: index === 0 ? 1 : 0,
      })),
    }),
  ).toHaveLength(1);
});
