import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { actionFingerprint } from "./support/request-approval-runner-fixture.js";
import {
  createPlannerReturnApprovalFixture,
  plannerObjective,
  workerObjective,
} from "./support/planner-return-approval-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("Planner return events across saved approval continuation", () => {
  test.each([true, false])(
    "publishes one result after resuming the original Planner with approval=%s",
    async (approved) => {
      const fixture = createPlannerReturnApprovalFixture(approved);
      const waiting = await runRequestRunner(fixture.makeRequest(), {
        durableApproval: true,
      });
      if (waiting.kind !== "awaiting_approval")
        throw new Error("expected saved approval wait");
      expect(fixture.events("role.returned")).toEqual([]);
      const delegations = fixture.events("role.delegated");
      expect(delegations).toEqual([
        {
          callerCallId: "call-1",
          callerRole: "supervisor",
          childCallId: "call-2",
          childRole: "planner",
          objective: plannerObjective,
        },
      ]);
      const persisted = JSON.parse(JSON.stringify(waiting.continuation));
      expect(persisted.ledger.state.calls).toHaveLength(3);
      expect(persisted.ledger.state.calls[1]).toMatchObject({
        callId: "call-2",
        parentCallId: "call-1",
        roleId: "planner",
        objective: plannerObjective,
        status: "waiting_for_child",
      });
      expect(persisted.ledger.state.calls[2]).toMatchObject({
        callId: "call-3",
        parentCallId: "call-2",
        roleId: "worker",
        objective: workerObjective,
      });
      expect(persisted.ledger.state.results).toEqual([]);
      expect(persisted.callers).toHaveLength(2);
      expect(persisted.preparedGroup.callId).toBe("call-3");
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(fixture.performed).not.toHaveBeenCalled();
      const beforeResume = fixture.invoke.mock.calls.map(
        ([input]) => input.modelStep,
      );
      expect(beforeResume).toEqual([
        "supervisor.decision",
        "supervisor.decision",
        "supervisor.decision",
        "supervisor.decision",
        "planner.decision",
        "worker.decision",
        "capability.controls",
      ]);

      const resumed = await runRequestRunner(fixture.makeRequest(), {
        durableApproval: true,
        continuation: persisted,
        decisions: [
          {
            approvalId: "approval-exact",
            actionFingerprint,
            decision: { approved },
          },
        ],
      });
      expect(resumed).toEqual({
        kind: "completed",
        result: { output: "The delegated action settled." },
      });
      expect(fixture.events("role.returned")).toEqual([
        {
          callerCallId: "call-1",
          callerRole: "supervisor",
          childCallId: "call-2",
          childRole: "planner",
          outcome: approved ? "completed" : "failed",
          summary: fixture.summary,
        },
      ]);
      expect(fixture.events("role.delegated")).toEqual(delegations);
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(fixture.restore).toHaveBeenCalledOnce();
      expect(fixture.executed).toHaveBeenCalledExactlyOnceWith(
        "capability-execution-1",
      );
      expect(fixture.performed).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(fixture.appliedDecisions).toHaveBeenCalledExactlyOnceWith({
        approvalId: "approval-exact",
        actionFingerprint,
        decision: { approved },
      });
      expect(
        fixture.invoke.mock.calls
          .slice(beforeResume.length)
          .map(([input]) => input.modelStep),
      ).toEqual([
        "worker.decision",
        "worker.result",
        "planner.decision",
        "supervisor.decision",
        "supervisor.response",
      ]);
      expect(fixture.invokeRaw).not.toHaveBeenCalled();
      expect(fixture.onAcknowledgement).toHaveBeenCalledOnce();
      expect(fixture.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        "The delegated action settled.",
      );
    },
  );
});
