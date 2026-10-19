import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  ROLE_CALL_RESULT_MAX_LENGTH,
  resolveRoleCallTransactions,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallLedgerCommit,
} from "../orchestration/role-calls/index.js";
import {
  captureRoleCallLedgerCheckpoint,
  restoreRoleCallLedgerCheckpoint,
} from "../orchestration/role-calls/checkpoint.js";
import {
  attachRequestRoleReturnEvents,
  projectRequestRoleReturnCommit,
} from "../request/role-call-return-events.js";
import {
  commit,
  createObservedReturnLedger,
  openChild,
  requestId,
  returnChild,
} from "./support/role-return-events-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("committed top-level Planner return events", () => {
  test.each(["completed", "failed"] as const)(
    "publishes the exact stored %s result after the canonical return",
    async (outcome) => {
      const { ledger, onEvent } = await createObservedReturnLedger();
      await openChild(ledger);
      expect(onEvent).not.toHaveBeenCalled();
      const summary = "  First paragraph.\n\nReport <target> & evidence.  ";
      onEvent.mockImplementation((_name, payload) => {
        const state = ledger.current().state;
        expect(state.activeCallId).toBe("call-1");
        expect(state.calls[1]).toMatchObject({
          status: "completed",
          resultRef: "result-1",
        });
        expect(state.results[0]).toMatchObject({
          producerCallId: payload.childCallId,
          outcome: payload.outcome,
          summary: payload.summary,
        });
      });
      const returned = await returnChild(ledger, { outcome, summary });
      expect(onEvent.mock.calls).toEqual([
        [
          "role.returned",
          {
            callerCallId: "call-1",
            callerRole: "supervisor",
            childCallId: "call-2",
            childRole: "planner",
            outcome,
            summary: summary.trim(),
          },
        ],
      ]);
      expect(ledger.current().state.plans).toHaveLength(0);
      const event = projectRequestRoleReturnCommit(returned);
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event?.payload)).toBe(true);
      expect(ledger.current()).toBe(returned.head);
    },
  );

  test("preserves role-result text beyond the capability summary limit", async () => {
    const { ledger, onEvent } = await createObservedReturnLedger();
    await openChild(ledger);
    const summary = "a".repeat(ROLE_CALL_RESULT_MAX_LENGTH + 1) + "\nFull ending.";
    await returnChild(ledger, { summary });
    expect(onEvent.mock.calls[0]?.[1].summary).toBe(summary);
  });

  test("distinguishes repeated summaries from different Planner calls", async () => {
    const { ledger, onEvent } = await createObservedReturnLedger();
    await openChild(ledger);
    await returnChild(ledger);
    await openChild(ledger);
    await returnChild(ledger, { childCallId: "call-3" });
    expect(onEvent.mock.calls.map(([, payload]) => payload.childCallId)).toEqual([
      "call-2",
      "call-3",
    ]);
    expect(onEvent.mock.calls[0]?.[1].summary).toBe(
      onEvent.mock.calls[1]?.[1].summary,
    );
  });

  test.each(["worker", "reviewer"] as const)(
    "excludes the direct %s result",
    async (roleId) => {
      const { ledger, onEvent } = await createObservedReturnLedger();
      await openChild(ledger, roleId);
      await returnChild(ledger);
      expect(onEvent).not.toHaveBeenCalled();
    },
  );

  test("excludes a nested Planner result", async () => {
    const { ledger, onEvent } = await createObservedReturnLedger();
    await openChild(ledger, "worker");
    await openChild(ledger, "planner", "call-2");
    await returnChild(ledger, {
      callerCallId: "call-2",
      childCallId: "call-3",
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("excludes Execution Agent advisory results with the shared root role", async () => {
    const { ledger, onEvent } = await createObservedReturnLedger({
      ...SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      id: "execution-agent-v1",
      rootContractId: "execution_agent",
      capabilityAuthorities: ["root"],
    });
    expect(ledger.current().state.calls[0]?.roleId).toBe("supervisor");
    await openChild(ledger);
    await returnChild(ledger);
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("does not emit for invalid or repeated returns", async () => {
    const { ledger, onEvent } = await createObservedReturnLedger();
    await openChild(ledger);
    const command = {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: " ",
    } as const;
    const rejected = await ledger.apply({
      expectedHead: ledger.current(),
      command,
    });
    expect(rejected).toMatchObject({ ok: false, code: "invalid_command" });
    expect(onEvent).not.toHaveBeenCalled();
    await returnChild(ledger);
    const repeated = await ledger.apply({
      expectedHead: ledger.current(),
      command: { ...command, summary: "Already returned." },
    });
    expect(repeated).toMatchObject({ ok: false, code: "child_return_mismatch" });
    expect(onEvent).toHaveBeenCalledOnce();
  });

  test("does not publish an incomplete Planner result or its nested Worker result", async () => {
    const { ledger, onEvent } = await createObservedReturnLedger();
    await openChild(ledger);
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-2",
      roleId: "worker",
      objective: "Inspect the source.",
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Inspect and report.",
          items: [
            { title: "Inspect", objective: "Inspect the source." },
            { title: "Report", objective: "Report the source evidence." },
          ],
        },
        selectedItemIndexes: [0],
      },
    });
    await returnChild(ledger, {
      callerCallId: "call-2",
      childCallId: "call-3",
    });
    const rejected = await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: "completed",
        summary: "Premature result.",
      },
    });
    expect(rejected).toMatchObject({ ok: false, code: "planner_plan_incomplete" });
    expect(onEvent).not.toHaveBeenCalled();
  });

  test("does not repeat a stored Planner result when restoring another child", async () => {
    const { ledger, onEvent } = await createObservedReturnLedger();
    await openChild(ledger);
    await returnChild(ledger);
    await openChild(ledger, "worker");
    expect(onEvent).toHaveBeenCalledOnce();
    const parked = await resolveRoleCallTransactions(ledger)
      .beginCapabilityExecution({
        expectedHead: ledger.current(),
        callId: "call-3",
        invocationAttempt: 1,
        capabilityId: "example.observe",
        declaredEffect: "observation",
        intent: "Observe the next source.",
        controlsJson: "{}",
        actionFingerprint: `sha256:${"a".repeat(64)}`,
      });
    if (!parked.ok) throw new Error("test_return_capability_not_parked");
    const checkpoint = JSON.parse(
      JSON.stringify(captureRoleCallLedgerCheckpoint(ledger)),
    );
    const restored = restoreRoleCallLedgerCheckpoint(checkpoint, {
      requestId,
      policy: ledger.current().policy,
    });
    const resumedEvents = vi.fn();
    attachRequestRoleReturnEvents({ ledger: restored, onEvent: resumedEvents });
    expect(restored.current().state.results).toEqual(
      ledger.current().state.results,
    );
    expect(resumedEvents).not.toHaveBeenCalled();
    const settled = await resolveRoleCallTransactions(restored)
      .settleCapabilityExecution({
        expectedHead: restored.current(),
        callId: "call-3",
        executionId: "capability-execution-1",
        outcome: "succeeded",
        observedEffect: "observation",
        summary: "Observed the next source.",
        exactResult: {
          kind: "generic_capability_result_v1",
          authority: "capability_adapter",
          status: "executed",
          ok: true,
          payload: { source: "next" },
        },
      });
    if (!settled.ok) throw new Error("test_return_capability_not_settled");
    await returnChild(restored, { childCallId: "call-3" });
    expect(resumedEvents).not.toHaveBeenCalled();
  });

  test.each(["resultRef", "producerCallId", "roleId", "outcome", "summary"])(
    "rejects a projected result with mismatched %s",
    async (field) => {
      const { ledger } = await createObservedReturnLedger();
      await openChild(ledger);
      const returned = await returnChild(ledger);
      const changed = structuredClone(returned);
      const result = changed.head.state.results[0] as unknown as Record<
        string,
        unknown
      >;
      result[field] = field === "summary" ? " " : "mismatched";
      expect(projectRequestRoleReturnCommit(changed)).toBeUndefined();
    },
  );

  test("requires the child's stored resultRef to match the return effect", async () => {
    const { ledger } = await createObservedReturnLedger();
    await openChild(ledger);
    const returned = await returnChild(ledger);
    const changed = {
      ...returned,
      effect: { ...returned.effect, resultRef: "another-result" },
    } as RoleCallLedgerCommit;
    expect(projectRequestRoleReturnCommit(changed)).toBeUndefined();
  });

  test.each(["throw", "thenable"] as const)(
    "preserves committed_with_fault when the event sink returns %s",
    async (failure) => {
      const { ledger, onEvent } = await createObservedReturnLedger();
      await openChild(ledger);
      onEvent.mockImplementation(() => {
        if (failure === "throw") throw new Error("event sink failed");
        return Promise.resolve();
      });
      const head = ledger.current();
      const result = await ledger.apply({
        expectedHead: head,
        command: {
          authority: "runtime",
          type: "return_child",
          callerCallId: "call-1",
          childCallId: "call-2",
          outcome: "failed",
          summary: "The delegated work could not finish.",
        },
      });
      expect(result).toMatchObject({
        ok: false,
        status: "committed_with_fault",
        code: "after_commit_fault",
        effect: { type: "child_returned", childCallId: "call-2" },
      });
      expect(ledger.current().revision).toBe(head.revision + 1);
      expect(ledger.current().state.activeCallId).toBe("call-1");
      expect(ledger.current().state.results[0]?.outcome).toBe("failed");
      expect(onEvent).toHaveBeenCalledOnce();
    },
  );
});
