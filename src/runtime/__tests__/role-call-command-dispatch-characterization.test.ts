import { describe, expect, test } from "vitest";

import {
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedgerCommand,
} from "../orchestration/role-calls/contracts.js";
import {
  applyRoleCallCommand,
  createInitialRoleCallState,
  sealRoleCallPolicy,
} from "../orchestration/role-calls/reducer.js";

const policy = sealRoleCallPolicy({
  limits: {
    maxDepth: 4,
    maxCalls: 8,
    maxCapabilityExecutions: 16,
    maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
    maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
    maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
  },
});

describe("role-call command dispatch characterization", () => {
  test.each([
    {
      authority: "supervisor",
      type: "complete_root_response",
      callId: "call-1",
      response: "No root exists yet.",
    },
    {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "No root exists yet.",
    },
    {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "No root exists yet.",
    },
  ] satisfies readonly RoleCallLedgerCommand[])(
    "preserves root_missing for $type before the canonical root exists",
    (command) => {
      const initial = createInitialRoleCallState("dispatch-characterization");
      const result = applyRoleCallCommand(initial, command, policy);

      expect(result).toEqual({
        ok: false,
        state: initial,
        code: "root_missing",
      });
      expect(result.state).toBe(initial);
    },
  );

  test("preserves root creation and terminal response effects", () => {
    const initial = createInitialRoleCallState("dispatch-characterization");
    const rooted = applyRoleCallCommand(
      initial,
      {
        authority: "runtime",
        type: "create_root",
      },
      policy,
    );

    expect(rooted).toMatchObject({
      ok: true,
      effect: { type: "root_created", callId: "call-1" },
      state: {
        phase: "running",
        rootCallId: "call-1",
        activeCallId: "call-1",
        callSequence: 1,
      },
    });
    if (!rooted.ok) throw new Error(rooted.code);

    const completed = applyRoleCallCommand(
      rooted.state,
      {
        authority: "supervisor",
        type: "complete_root_response",
        callId: "call-1",
        response: "  Characterized response.  ",
      },
      policy,
    );

    expect(completed).toMatchObject({
      ok: true,
      effect: { type: "root_response_committed", callId: "call-1" },
      state: {
        phase: "completed",
        activeCallId: null,
        rootResponse: "Characterized response.",
        calls: [{ callId: "call-1", status: "completed" }],
      },
    });
    if (!completed.ok) throw new Error(completed.code);
    expect(completed.effect).toEqual({
      type: "root_response_committed",
      callId: "call-1",
    });
  });
});
