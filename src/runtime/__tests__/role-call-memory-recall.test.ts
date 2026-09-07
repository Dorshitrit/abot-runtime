import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createRoleCallLedger,
  createRoleCallTransactions,
  ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH,
  ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedger,
  type RoleMemoryRecallResult,
} from "../orchestration/role-calls/index.js";

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
const record = {
  id: "memory-1",
  content: "The project uses TypeScript.",
  tags: ["project"],
  provenance: { kind: "manual" as const, source: "management_api" as const },
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
};

async function rootedLedger(
  maxCalls = 8,
  maxCapabilityExecutions = 16,
): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId: "memory-recall-request",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      limits: {
        maxDepth: 4,
        maxCalls,
        maxCapabilityExecutions,
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

function identity(ledger: RoleCallLedger) {
  const head = ledger.current();
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  )!;
  return {
    expectedHead: head,
    callId: call.callId,
    invocationAttempt: call.activationCount,
    steeringVersion: 0,
  };
}

async function begin(ledger: RoleCallLedger) {
  const input = identity(ledger);
  const begun = await ledger.transactions!.beginMemoryRecall({
    ...input,
    query: "project language",
  });
  if (!begun.ok) throw new Error(begun.issueCode);
  return {
    ...input,
    expectedHead: begun.commit.head,
    recallId: begun.commit.effect.recallId,
  };
}

describe("canonical root memory recall", () => {
  test("returns a bounded immutable result to the same root without child or capability records", async () => {
    const ledger = await rootedLedger();
    const initial = ledger.current();
    const pending = await begin(ledger);
    expect(ledger.current().state.calls[0]).toMatchObject({
      status: "waiting_for_memory",
      activationCount: 1,
    });
    const result: RoleMemoryRecallResult = {
      outcome: "found",
      records: [record],
      omittedRecordCount: 2,
    };
    const settled = await ledger.transactions!.settleMemoryRecall({
      ...pending,
      result,
    });
    expect(settled.ok).toBe(true);
    const state = ledger.current().state;
    expect(state.calls[0]).toMatchObject({
      callId: initial.state.rootCallId,
      status: "active",
      activationCount: 2,
    });
    expect(state.calls).toHaveLength(1);
    expect(state.capabilityExecutions).toEqual([]);
    expect(state.results).toEqual([]);
    expect(state.plans).toEqual([]);
    expect(state.memoryRecalls[0]).toMatchObject({
      recallId: pending.recallId,
      callId: pending.callId,
      status: "settled",
      result,
    });
    expect(Object.isFrozen(state.memoryRecalls)).toBe(true);
    expect(
      Object.isFrozen(state.memoryRecalls[0]?.result?.records[0]?.provenance),
    ).toBe(true);
    const completed = await ledger.transactions!.completeRootResponse({
      expectedHead: ledger.current(),
      callId: pending.callId,
      response: "TypeScript.",
    });
    expect(completed.ok).toBe(true);
  });

  test.each(["empty", "unavailable", "superseded"] as const)(
    "settles %s without inventing evidence",
    async (outcome) => {
      const ledger = await rootedLedger();
      const pending = await begin(ledger);
      const settled = await ledger.transactions!.settleMemoryRecall({
        ...pending,
        result: { ...empty, outcome },
      });
      expect(settled.ok).toBe(true);
      expect(ledger.current().state.calls[0]?.activationCount).toBe(2);
      expect(ledger.current().state.memoryRecalls[0]?.result?.records).toEqual(
        [],
      );
    },
  );

  test("rejects a child caller even when that child has capability authority", async () => {
    const ledger = await rootedLedger();
    const opened = await ledger.transactions!.openChild({
      expectedHead: ledger.current(),
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Do bounded work.",
    });
    expect(opened.ok).toBe(true);
    const before = ledger.current();
    const rejected = await ledger.transactions!.beginMemoryRecall({
      ...identity(ledger),
      query: "project",
    });
    expect(rejected).toMatchObject({
      ok: false,
      issueCode: "memory_recall_caller_invalid",
    });
    expect(ledger.current()).toBe(before);
  });

  test("rejects stale heads and repeated begin while the root waits", async () => {
    const ledger = await rootedLedger();
    const original = identity(ledger);
    const pending = await begin(ledger);
    const before = ledger.current();
    const stale = await ledger.transactions!.beginMemoryRecall({
      ...original,
      query: "other",
    });
    expect(stale).toMatchObject({ ok: false, issueCode: "stale_head" });
    const repeated = await ledger.transactions!.beginMemoryRecall({
      ...identity(ledger),
      query: "other",
    });
    expect(repeated).toMatchObject({
      ok: false,
      issueCode: "memory_recall_caller_invalid",
    });
    const terminal = await ledger.transactions!.completeRootResponse({
      expectedHead: before,
      callId: pending.callId,
      response: "Too soon.",
    });
    expect(terminal).toMatchObject({
      ok: false,
      issueCode: "root_response_not_allowed",
    });
    expect(ledger.current()).toBe(before);
  });

  test.each([
    { callId: "call-other" },
    { recallId: "recall-other" },
    { invocationAttempt: 2 },
    { steeringVersion: 1 },
  ])("rejects mismatched settlement identity %j", async (override) => {
    const ledger = await rootedLedger();
    const pending = await begin(ledger);
    const before = ledger.current();
    const rejected = await ledger.transactions!.settleMemoryRecall({
      ...pending,
      ...override,
      result: empty,
    });
    expect(rejected.ok).toBe(false);
    expect(ledger.current()).toBe(before);
    expect(ledger.current().state.memoryRecalls[0]?.status).toBe("pending");
  });

  test("rejects stale activation and regressing steering before retrieval admission", async () => {
    const ledger = await rootedLedger();
    const invalid = await ledger.transactions!.beginMemoryRecall({
      ...identity(ledger),
      invocationAttempt: 2,
      query: "project",
    });
    expect(invalid).toMatchObject({
      ok: false,
      issueCode: "memory_recall_invocation_mismatch",
    });
    const accepted = await ledger.transactions!.beginMemoryRecall({
      ...identity(ledger),
      steeringVersion: 3,
      query: "project",
    });
    if (!accepted.ok) throw new Error(accepted.issueCode);
    await ledger.transactions!.settleMemoryRecall({
      ...identity(ledger),
      recallId: accepted.commit.effect.recallId,
      steeringVersion: 3,
      result: empty,
    });
    const before = ledger.current();
    const oldSteering = await ledger.transactions!.beginMemoryRecall({
      ...identity(ledger),
      steeringVersion: 2,
      query: "project",
    });
    expect(oldSteering).toMatchObject({
      ok: false,
      issueCode: "memory_recall_invocation_mismatch",
    });
    expect(ledger.current()).toBe(before);
  });

  test("uses the existing activation ceiling and rejects before another retrieval can start", async () => {
    const ledger = await rootedLedger(1, 1);
    const retrieve = vi.fn();
    for (let index = 0; index < 2; index += 1) {
      const pending = await begin(ledger);
      retrieve();
      expect(
        (
          await ledger.transactions!.settleMemoryRecall({
            ...pending,
            result: empty,
          })
        ).ok,
      ).toBe(true);
    }
    const before = ledger.current();
    const rejected = await ledger.transactions!.beginMemoryRecall({
      ...identity(ledger),
      query: "again",
    });
    if (rejected.ok) retrieve();
    expect(rejected).toMatchObject({
      ok: false,
      issueCode: "role_activation_limit_exceeded",
    });
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(ledger.current()).toBe(before);
    expect(ledger.current().state.memoryRecalls).toHaveLength(2);
    expect(
      (
        await ledger.transactions!.completeRootResponse({
          expectedHead: before,
          callId: "call-1",
          response: "Done.",
        })
      ).ok,
    ).toBe(true);
  });

  test.each(["", " ", "x".repeat(ROLE_MEMORY_RECALL_QUERY_MAX_LENGTH + 1)])(
    "rejects an invalid query before commit",
    async (query) => {
      const ledger = await rootedLedger();
      const before = ledger.current();
      const result = await ledger.transactions!.beginMemoryRecall({
        ...identity(ledger),
        query,
      });
      expect(result).toMatchObject({ ok: false, issueCode: "invalid_command" });
      expect(ledger.current()).toBe(before);
    },
  );

  test.each([
    { outcome: "found", records: [], omittedRecordCount: 0 },
    { outcome: "empty", records: [record], omittedRecordCount: 0 },
    {
      outcome: "found",
      records: Array.from({ length: 7 }, (_, id) => ({
        ...record,
        id: String(id),
      })),
      omittedRecordCount: 0,
    },
    {
      outcome: "found",
      records: [
        {
          ...record,
          content: "x".repeat(ROLE_MEMORY_RECALL_RESULT_MAX_LENGTH),
        },
      ],
      omittedRecordCount: 0,
    },
    {
      outcome: "found",
      records: [{ ...record, provenance: { kind: "unknown" } }],
      omittedRecordCount: 0,
    },
    { ...empty, omittedRecordCount: -1 },
  ])("rejects invalid result bounds or provenance", async (result) => {
    const ledger = await rootedLedger();
    const pending = await begin(ledger);
    const before = ledger.current();
    const { expectedHead: _expectedHead, ...binding } = pending;
    const rejected = await ledger.apply({
      expectedHead: before,
      command: {
        authority: "runtime",
        type: "settle_memory_recall",
        ...binding,
        result,
      },
    });
    expect(rejected).toMatchObject({ ok: false, code: "invalid_command" });
    expect(ledger.current()).toBe(before);
  });

  test("transaction facade rejects the wrong effect without hiding canonical failures", async () => {
    const ledger = await rootedLedger();
    const original = identity(ledger);
    const begun = await ledger.transactions!.beginMemoryRecall({
      ...original,
      query: "project",
    });
    if (!begun.ok) throw new Error(begun.issueCode);
    const transactions = createRoleCallTransactions(async () => begun.commit);
    expect(
      await transactions.settleMemoryRecall({
        ...original,
        recallId: begun.commit.effect.recallId,
        result: empty,
      }),
    ).toMatchObject({
      ok: false,
      issueCode: "memory_recall_transition_invalid",
    });
  });
});
