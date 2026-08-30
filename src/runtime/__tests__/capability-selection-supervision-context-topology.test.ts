import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallFrame,
  type RoleCallLedger,
} from "../orchestration/role-calls/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  buildExecutionDecisionStateMessage,
  buildExecutionRefinementStateMessage,
  buildExecutionResponseStateMessage,
  buildExecutionStateMessage,
} from "../steps/execution-agent/state-context.js";

const RAW_FIRST_INTENT = "raw-intent-first-do-not-project";
const RAW_SECOND_INTENT = "raw-intent-second-do-not-project";
const RAW_CONTROLS_VALUE = "raw-controls-do-not-project";
const RAW_FIRST_REASON = "raw-reason-first-do-not-project";
const RAW_SECOND_REASON = "raw-reason-second-do-not-project";
const SELECTION_CONTROLS_JSON = JSON.stringify({
  marker: RAW_CONTROLS_VALUE,
  path: "target.txt",
});

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("pre-execution capability-selection supervision context topology", () => {
  test("projects the immediate warning only inside the Execution Agent decision receipt", async () => {
    const ledger = await createWarningLedger();
    const head = ledger.current();
    const call = requireActiveCall(ledger);
    const decisionState = parseStateMessage(
      buildExecutionDecisionStateMessage(head, call, 0).content,
    );
    const controlsState = parseStateMessage(
      buildExecutionRefinementStateMessage(head, call).content,
    );
    const responseState = parseStateMessage(
      buildExecutionResponseStateMessage(head, call).content,
    );
    const genericState = parseStateMessage(
      buildExecutionStateMessage(head, call).content,
    );

    const reconsideration = requireRecord(
      decisionState.capabilitySelectionReconsideration,
      "decision reconsideration",
    );
    const supervision = requireRecord(
      reconsideration.supervision,
      "decision reconsideration supervision",
    );

    expect(supervision).toEqual({
      authority: "canonical_role_call_ledger",
      presenceEffect: "passive_mechanical_supervision_not_next_action",
      callId: "call-1",
      invocationAttempt: 3,
      steeringVersion: 0,
      executionOccurred: false,
      stage: "warning",
      trigger: "repeat_identity",
      selectionFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      matchingSelectionCount: 2,
      totalReconsiderationCount: 2,
      limits: {
        repeat: { warningAt: 2, intervenedAt: 3, terminalAt: 4 },
        total: { warningAt: 6, intervenedAt: 7, terminalAt: 8 },
      },
    });
    expect(decisionState).not.toHaveProperty("capabilitySelectionSupervision");

    for (const nonDecisionState of [
      controlsState,
      responseState,
      genericState,
    ]) {
      expect(nonDecisionState).not.toHaveProperty(
        "capabilitySelectionReconsideration",
      );
      expect(nonDecisionState).not.toHaveProperty(
        "capabilitySelectionSupervision",
      );
      expect(nonDecisionState.omissionSemantics).not.toHaveProperty(
        "capabilitySelectionReconsideration",
      );
    }

    const supervisionJson = JSON.stringify(supervision);
    for (const forbiddenRawValue of [
      RAW_FIRST_INTENT,
      RAW_SECOND_INTENT,
      RAW_CONTROLS_VALUE,
      RAW_FIRST_REASON,
      RAW_SECOND_REASON,
      SELECTION_CONTROLS_JSON,
    ]) {
      expect(supervisionJson).not.toContain(forbiddenRawValue);
    }
    for (const forbiddenRawField of ["intent", "controls", "reason"]) {
      expect(supervision).not.toHaveProperty(forbiddenRawField);
    }

    const steeredDecisionState = parseStateMessage(
      buildExecutionDecisionStateMessage(head, call, 1).content,
    );
    expect(steeredDecisionState).not.toHaveProperty(
      "capabilitySelectionReconsideration",
    );
  });
});

async function createWarningLedger(): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId: "capability-selection-supervision-context-topology",
    policy: {
      authority: executionAgentAuthority(),
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role",
    type: "update_capability_scope",
    callId: "call-1",
    invocationAttempt: 1,
    mode: "open",
    catalogGroupIds: ["files"],
  });
  await commitReconsideration(ledger, {
    intent: RAW_FIRST_INTENT,
    reason: RAW_FIRST_REASON,
    workingDirectory: null,
  });
  await commitReconsideration(ledger, {
    intent: RAW_SECOND_INTENT,
    reason: RAW_SECOND_REASON,
    workingDirectory: ".",
  });
  return ledger;
}

async function commitReconsideration(
  ledger: RoleCallLedger,
  input: Readonly<{
    intent: string;
    reason: string;
    workingDirectory: string | null;
  }>,
): Promise<void> {
  const call = requireActiveCall(ledger);
  await commit(ledger, {
    authority: "active_role",
    type: "reconsider_capability_selection",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    steeringVersion: 0,
    selection: {
      action: "invoke_capability",
      invocations: [
        {
          capabilityId: "files.read",
          intent: input.intent,
          selectionControlsJson: SELECTION_CONTROLS_JSON,
        },
      ],
      workingDirectory: input.workingDirectory,
      activeCapabilityCatalogGroupIds: ["files"],
    },
    cause: {
      kind: "refinement_declined",
      entries: [
        {
          invocationIndex: 0,
          reason: input.reason,
        },
      ],
    },
  });
}

function executionAgentAuthority(): ExecutionPolicyAuthoritySnapshot {
  return Object.freeze({
    id: "execution-agent-v1",
    version: 1,
    definitionHash: `sha256:${"d".repeat(64)}`,
    rootContractId: "execution_agent",
    availableSubordinateContractIds: Object.freeze(["worker"] as const),
    capabilityAuthorities: Object.freeze(["root"] as const),
  });
}

function requireActiveCall(ledger: RoleCallLedger): RoleCallFrame {
  const head = ledger.current();
  const call = head.state.calls.find(
    ({ callId }) => callId === head.state.activeCallId,
  );
  if (!call) throw new Error("active call missing");
  return call;
}

async function commit(ledger: RoleCallLedger, command: unknown): Promise<void> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
}

function parseStateMessage(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} missing`);
  }
  return input as Record<string, unknown>;
}
