import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallPolicy,
} from "../orchestration/role-calls/index.js";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SELECTION_CONTROLS_SECRET =
  "RAW_SELECTION_CONTROLS_SECRET_MUST_NOT_BE_LOGGED";
const EXECUTION_CONTROLS_SECRET =
  "RAW_EXECUTION_CONTROLS_SECRET_MUST_NOT_BE_LOGGED";

function createExecutionAgentLedger(): RoleCallLedger {
  const policy: RoleCallPolicy = {
    authority: {
      id: "execution-agent-v1",
      version: 1,
      definitionHash: `sha256:${"a".repeat(64)}`,
      rootContractId: "execution_agent",
      availableSubordinateContractIds: ["worker"],
      capabilityAuthorities: ["root", "worker"],
    },
    limits: {
      maxDepth: 4,
      maxCalls: 8,
      maxCapabilityExecutions: 16,
      maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
      maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
      maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
    },
  };
  return createRoleCallLedger({
    requestId: "selection-supervision-diagnostics-request",
    policy,
  });
}

async function commit(ledger: RoleCallLedger, command: unknown): Promise<void> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  expect(result).toMatchObject({ ok: true, status: "committed" });
  if (!result.ok) throw new Error(result.code);
}

async function prepareActiveRoot(ledger: RoleCallLedger): Promise<void> {
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role",
    type: "update_capability_scope",
    callId: "call-1",
    invocationAttempt: 1,
    mode: "open",
    catalogGroupIds: ["read"],
  });
}

function reconsiderationCommand(input: {
  invocationAttempt: number;
  steeringVersion?: number;
  intentSuffix: string;
  reasonSuffix: string;
}) {
  return {
    authority: "active_role",
    type: "reconsider_capability_selection",
    callId: "call-1",
    invocationAttempt: input.invocationAttempt,
    steeringVersion: input.steeringVersion ?? 0,
    selection: {
      action: "invoke_capability",
      invocations: [
        {
          capabilityId: "files.read",
          intent: `RAW_INTENT_SECRET_${input.intentSuffix}`,
          selectionControlsJson: JSON.stringify({
            path: SELECTION_CONTROLS_SECRET,
          }),
        },
      ],
      workingDirectory: ".",
      activeCapabilityCatalogGroupIds: ["read"],
    },
    cause: {
      kind: "refinement_declined",
      entries: [
        {
          invocationIndex: 0,
          reason: `RAW_REASON_SECRET_${input.reasonSuffix}`,
        },
      ],
    },
  } as const;
}

async function captureRoleCallLogs(
  run: () => Promise<void>,
): Promise<Record<string, unknown>[]> {
  configureDebugLogger({ enabled: true });
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await run();
    return consoleLog.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
  } finally {
    consoleLog.mockRestore();
  }
}

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("role-call capability-selection supervision diagnostics", () => {
  test("logs bounded hashes and counters for warning, intervention, and terminal rejection without raw model material", async () => {
    const ledger = createExecutionAgentLedger();
    const logs = await captureRoleCallLogs(async () => {
      await prepareActiveRoot(ledger);
      await commit(
        ledger,
        reconsiderationCommand({
          invocationAttempt: 2,
          intentSuffix: "ONE",
          reasonSuffix: "ONE",
        }),
      );
      await commit(
        ledger,
        reconsiderationCommand({
          invocationAttempt: 3,
          intentSuffix: "TWO",
          reasonSuffix: "TWO",
        }),
      );
      await commit(
        ledger,
        reconsiderationCommand({
          invocationAttempt: 4,
          intentSuffix: "THREE",
          reasonSuffix: "THREE",
        }),
      );

      const rejected = await ledger.apply({
        expectedHead: ledger.current(),
        command: reconsiderationCommand({
          invocationAttempt: 5,
          intentSuffix: "FOUR",
          reasonSuffix: "FOUR",
        }),
      });
      expect(rejected).toMatchObject({
        ok: false,
        status: "rejected",
        code: "capability_selection_supervision_limit_exceeded",
      });
    });

    const reconsidered = logs.filter(
      (entry) => entry.event === "capability.selection_reconsidered",
    );
    const warning = reconsidered.find(
      (entry) => entry.selectionSupervisionStage === "warning",
    );
    const intervened = reconsidered.find(
      (entry) => entry.selectionSupervisionStage === "intervened",
    );
    expect(warning).toMatchObject({
      scope: "runtime.role_calls",
      callId: "call-1",
      invocationAttempt: 3,
      steeringVersion: 0,
      selectionReceiptFingerprint: expect.stringMatching(HASH_PATTERN),
      selectionSupervisionFingerprint: expect.stringMatching(HASH_PATTERN),
      selectionSupervisionStage: "warning",
      selectionSupervisionTrigger: "repeat_identity",
      matchingSelectionCount: 2,
      totalReconsiderationCount: 2,
      causeKind: "refinement_declined",
      declinedInvocationCount: 1,
    });
    expect(intervened).toMatchObject({
      scope: "runtime.role_calls",
      callId: "call-1",
      invocationAttempt: 4,
      selectionReceiptFingerprint: expect.stringMatching(HASH_PATTERN),
      selectionSupervisionFingerprint: expect.stringMatching(HASH_PATTERN),
      selectionSupervisionStage: "intervened",
      selectionSupervisionTrigger: "repeat_identity",
      matchingSelectionCount: 3,
      totalReconsiderationCount: 3,
    });
    expect(intervened?.selectionSupervisionFingerprint).toBe(
      warning?.selectionSupervisionFingerprint,
    );
    expect(intervened?.selectionReceiptFingerprint).not.toBe(
      warning?.selectionReceiptFingerprint,
    );

    const terminal = logs.find(
      (entry) => entry.event === "capability_selection.supervision_terminal",
    );
    expect(terminal).toMatchObject({
      scope: "runtime.role_calls",
      commandType: "reconsider_capability_selection",
      rejectionCode: "capability_selection_supervision_limit_exceeded",
      attemptedCallId: "call-1",
      attemptedInvocationAttempt: 5,
      attemptedSteeringVersion: 0,
      attemptedSelectionReceiptFingerprint: expect.stringMatching(HASH_PATTERN),
      attemptedSelectionSupervisionFingerprint:
        warning?.selectionSupervisionFingerprint,
      selectionSupervisionStage: "terminal",
      selectionSupervisionTrigger: "repeat_identity",
      matchingSelectionCount: 4,
      totalReconsiderationCount: 4,
      issueCount: 1,
      issues: [
        {
          code: "capability_selection_repeat_limit_exceeded",
          path: "state.capabilitySelectionSupervision",
        },
      ],
    });
    expect(
      logs.filter(
        (entry) => entry.event === "capability_selection.supervision_terminal",
      ),
    ).toHaveLength(1);
    expect(
      logs.filter(
        (entry) =>
          entry.event === "transition.rejected" &&
          entry.rejectionCode ===
            "capability_selection_supervision_limit_exceeded",
      ),
    ).toHaveLength(1);

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SELECTION_CONTROLS_SECRET);
    expect(serialized).not.toContain("RAW_INTENT_SECRET");
    expect(serialized).not.toContain("RAW_REASON_SECRET");
  });

  test("logs explicit reset causes for a new steering epoch and materialized progress", async () => {
    const ledger = createExecutionAgentLedger();
    const logs = await captureRoleCallLogs(async () => {
      await prepareActiveRoot(ledger);
      await commit(
        ledger,
        reconsiderationCommand({
          invocationAttempt: 2,
          intentSuffix: "STEERING_ZERO_ONE",
          reasonSuffix: "STEERING_ZERO_ONE",
        }),
      );
      await commit(
        ledger,
        reconsiderationCommand({
          invocationAttempt: 3,
          intentSuffix: "STEERING_ZERO_TWO",
          reasonSuffix: "STEERING_ZERO_TWO",
        }),
      );
      await commit(
        ledger,
        reconsiderationCommand({
          invocationAttempt: 4,
          steeringVersion: 1,
          intentSuffix: "STEERING_ONE",
          reasonSuffix: "STEERING_ONE",
        }),
      );
      await commit(ledger, {
        authority: "active_role",
        type: "begin_capability_execution",
        callId: "call-1",
        invocationAttempt: 5,
        capabilityId: "files.read",
        declaredEffect: "observation",
        intent: "RAW_EXECUTION_INTENT_SECRET_MUST_NOT_BE_LOGGED",
        controlsJson: JSON.stringify({ path: EXECUTION_CONTROLS_SECRET }),
      });
    });

    const resets = logs.filter(
      (entry) => entry.event === "capability_selection.supervision_reset",
    );
    expect(resets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "runtime.role_calls",
          callId: "call-1",
          steeringVersion: 0,
          nextSteeringVersion: 1,
          resetReason: "steering_version_changed",
          clearedRecordCount: 2,
          clearedIdentityCount: 1,
        }),
        expect.objectContaining({
          scope: "runtime.role_calls",
          callId: "call-1",
          steeringVersion: 1,
          resetReason: "materialized_capability_attempt",
          clearedRecordCount: 1,
          clearedIdentityCount: 1,
        }),
      ]),
    );
    expect(resets).toHaveLength(2);

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SELECTION_CONTROLS_SECRET);
    expect(serialized).not.toContain(EXECUTION_CONTROLS_SECRET);
    expect(serialized).not.toContain("RAW_INTENT_SECRET");
    expect(serialized).not.toContain("RAW_REASON_SECRET");
    expect(serialized).not.toContain(
      "RAW_EXECUTION_INTENT_SECRET_MUST_NOT_BE_LOGGED",
    );
  });
});
