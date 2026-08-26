import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
} from "../orchestration/role-calls/index.js";
import {
  projectSupervisorCallIdentity,
  projectSupervisorResumeContext,
} from "../steps/supervisor-decision/index.js";

function createLedger() {
  return createRoleCallLedger({
    requestId: "supervisor-projection-request",
    policy: {
      limits: {
        maxDepth: 2,
        maxCalls: 4,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("Supervisor projections from the canonical role-call ledger", () => {
  test("derives the model call identity and cumulative exact completed-child returns", async () => {
    const ledger = createLedger();
    await ledger.apply({
      expectedHead: ledger.current(),
      command: { authority: "runtime", type: "create_root" },
    });
    expect(projectSupervisorCallIdentity(ledger.current())).toEqual({
      rootCallId: "call-1",
      callId: "call-1",
      parentCallId: null,
      depth: 0,
      invocationAttempt: 1,
    });

    await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "planner",
        objective: "Coordinate the bounded work.",
      },
    });
    const firstReturned = await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: "completed",
        summary: "The coordinated result.",
      },
    });

    expect(projectSupervisorCallIdentity(ledger.current())).toEqual({
      rootCallId: "call-1",
      callId: "call-1",
      parentCallId: null,
      depth: 0,
      invocationAttempt: 2,
    });
    expect(projectSupervisorResumeContext(ledger, firstReturned)).toEqual({
      callerCallId: "call-1",
      invocationAttempt: 2,
      returnedChildCallId: "call-2",
      returnedResultRef: "result-1",
      completedChildren: [
        {
          callerCallId: "call-1",
          childCallId: "call-2",
          resultRef: "result-1",
          roleId: "planner",
          objective: "Coordinate the bounded work.",
          dependencyResultRefs: [],
          outcome: "completed",
          summary: "The coordinated result.",
        },
      ],
    });

    await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "worker",
        objective: "Check the remaining bounded outcome.",
      },
    });
    const secondReturned = await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-3",
        outcome: "failed",
        summary: "The remaining outcome is not established.",
      },
    });

    expect(projectSupervisorCallIdentity(ledger.current())).toEqual({
      rootCallId: "call-1",
      callId: "call-1",
      parentCallId: null,
      depth: 0,
      invocationAttempt: 3,
    });
    const cumulative = projectSupervisorResumeContext(ledger, secondReturned);
    expect(cumulative).toEqual({
      callerCallId: "call-1",
      invocationAttempt: 3,
      returnedChildCallId: "call-3",
      returnedResultRef: "result-2",
      completedChildren: [
        {
          callerCallId: "call-1",
          childCallId: "call-2",
          resultRef: "result-1",
          roleId: "planner",
          objective: "Coordinate the bounded work.",
          dependencyResultRefs: [],
          outcome: "completed",
          summary: "The coordinated result.",
        },
        {
          callerCallId: "call-1",
          childCallId: "call-3",
          resultRef: "result-2",
          roleId: "worker",
          objective: "Check the remaining bounded outcome.",
          dependencyResultRefs: [],
          outcome: "failed",
          summary: "The remaining outcome is not established.",
        },
      ],
    });
    expect(Object.isFrozen(cumulative)).toBe(true);
    expect(Object.isFrozen(cumulative.completedChildren)).toBe(true);
    expect(cumulative.completedChildren.every(Object.isFrozen)).toBe(true);
  });

  test("rejects a tampered result reference instead of resolving another child result", async () => {
    const ledger = createLedger();
    await ledger.apply({
      expectedHead: ledger.current(),
      command: { authority: "runtime", type: "create_root" },
    });
    await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "active_role",
        type: "open_child",
        callerCallId: "call-1",
        roleId: "worker",
        objective: "Perform the bounded work.",
      },
    });
    const returned = await ledger.apply({
      expectedHead: ledger.current(),
      command: {
        authority: "runtime",
        type: "return_child",
        callerCallId: "call-1",
        childCallId: "call-2",
        outcome: "completed",
        summary: "Done.",
      },
    });
    if (!returned.ok || returned.effect.type !== "child_returned") {
      throw new Error("test_return_commit_missing");
    }
    const tampered = {
      ...returned,
      effect: {
        ...returned.effect,
        resultRef: "result-other",
      },
    } as typeof returned;

    expect(() => projectSupervisorResumeContext(ledger, tampered)).toThrow(
      "role_child_return_result_invalid",
    );
  });
});
