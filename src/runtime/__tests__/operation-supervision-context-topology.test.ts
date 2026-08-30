import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type ExecutionPolicyAuthoritySnapshot,
  type RoleCallFrame,
  type RoleCallLedger,
} from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityBinding } from "../orchestration/worker-capabilities/index.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  buildExecutionContinuationMessages,
  buildExecutionDecisionStateMessage,
  buildExecutionRefinementStateMessage,
  buildExecutionResponseStateMessage,
} from "../steps/execution-agent/state-context.js";
import {
  CAPABILITY_CONTROLS_MODEL_STEP,
  projectWorkerDecisionCallIdentity,
  WORKER_DECISION_MODEL_STEP,
} from "../steps/worker-decision/contracts.js";
import { prepareWorkerCanonicalState } from "../steps/worker-decision/input/canonical-state.js";

const ACTION_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const OUTCOME_FINGERPRINT = "succeeded";
const EXACT_PAYLOAD = Object.freeze({ marker: "exact-tool-result" });

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("runtime operation supervision context topology", () => {
  test("projects an immediate warning only in the Execution Agent decision state", async () => {
    const ledger = await createWarningLedger("root");
    const head = ledger.current();
    const call = requireActiveCall(ledger);
    const decisionState = parseStateMessage(
      buildExecutionDecisionStateMessage(head, call).content,
    );
    const refinementState = parseStateMessage(
      buildExecutionRefinementStateMessage(head, call).content,
    );
    const responseState = parseStateMessage(
      buildExecutionResponseStateMessage(head, call).content,
    );

    expect(decisionState.operationSupervision).toEqual([
      expect.objectContaining({
        kind: "runtime_operation_supervision_v1",
        authority: "runtime_state",
        presenceEffect: "passive_mechanical_intervention_not_user_intent",
        stage: "warning",
        actionFingerprint: ACTION_FINGERPRINT,
        priorOutcome: "succeeded",
        outcomeFingerprint: OUTCOME_FINGERPRINT,
        originExecutionId: "capability-execution-2",
        matchingOutcomeCount: 2,
        interventionCount: 0,
      }),
    ]);
    for (const nonDecisionState of [refinementState, responseState]) {
      expect(nonDecisionState).not.toHaveProperty("operationSupervision");
      expect(nonDecisionState.omissionSemantics).not.toHaveProperty(
        "operationSupervision",
      );
    }

    const continuation = buildExecutionContinuationMessages(head, call);
    const toolResults = continuation.filter(({ role }) => role === "tool");
    expect(toolResults).toHaveLength(2);
    expect(toolResults.map(({ content }) => JSON.parse(content))).toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ adapterResult: exactResult() }),
      }),
      expect.objectContaining({
        result: expect.objectContaining({ adapterResult: exactResult() }),
      }),
    ]);
  });

  test("projects an immediate intervention without inventing a capability result", async () => {
    const ledger = await createWarningLedger("root");
    const callBeforeIntervention = requireActiveCall(ledger);
    const executionCountBeforeIntervention =
      ledger.current().state.capabilityExecutions.length;
    await commit(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: callBeforeIntervention.callId,
      invocationAttempt: callBeforeIntervention.activationCount,
      capabilityId: "files.read",
      declaredEffect: "observation",
      intent: "Read one exact target.",
      controlsJson: JSON.stringify({ path: "target.txt" }),
      actionFingerprint: ACTION_FINGERPRINT,
    });

    const head = ledger.current();
    const call = requireActiveCall(ledger);
    const decisionState = parseStateMessage(
      buildExecutionDecisionStateMessage(head, call).content,
    );

    expect(decisionState.operationSupervision).toEqual([
      expect.objectContaining({
        kind: "runtime_operation_supervision_v1",
        stage: "intervention",
        actionFingerprint: ACTION_FINGERPRINT,
        outcomeFingerprint: OUTCOME_FINGERPRINT,
        originExecutionId: "capability-execution-2",
        interventionCount: 1,
      }),
    ]);
    expect(head.state.capabilityExecutions).toHaveLength(
      executionCountBeforeIntervention,
    );
  });

  test("projects reconsideration only in the next Execution Agent decision state", async () => {
    const ledger = await createReconsiderationLedger();
    const head = ledger.current();
    const call = requireActiveCall(ledger);
    const decisionState = parseStateMessage(
      buildExecutionDecisionStateMessage(head, call).content,
    );
    const refinementState = parseStateMessage(
      buildExecutionRefinementStateMessage(head, call).content,
    );
    const responseState = parseStateMessage(
      buildExecutionResponseStateMessage(head, call).content,
    );

    expect(decisionState.capabilitySelectionReconsideration).toMatchObject({
      kind: "runtime_execution_capability_reconsideration_v1",
      authority: "canonical_role_call_ledger",
      presenceEffect: "passive_continuity_not_next_action",
      outcome: "reconsidered_before_execution",
      executionOccurred: false,
      cause: {
        kind: "refinement_declined",
        entries: [
          {
            invocationIndex: 0,
            reason: "The selected capability does not apply.",
          },
        ],
      },
      selection: {
        action: "invoke_capability",
        invocations: [
          {
            capabilityId: "files.write",
            selectionControls: { path: "target.txt" },
          },
        ],
      },
    });
    for (const nonDecisionState of [refinementState, responseState]) {
      expect(nonDecisionState).not.toHaveProperty(
        "capabilitySelectionReconsideration",
      );
      expect(nonDecisionState.omissionSemantics).not.toHaveProperty(
        "capabilitySelectionReconsideration",
      );
    }
    expect(buildExecutionContinuationMessages(head, call)).toEqual([]);
  });

  test("does not prepare operation supervision for a pending Worker refinement", async () => {
    const ledger = await createWarningLedger("worker");
    const head = ledger.current();
    const call = requireActiveCall(ledger);
    const capabilitySource = Object.freeze({
      ledger,
      head,
      binding: createBinding(ledger, call),
    });
    const request = Object.freeze({
      requestId: head.state.requestId,
      prompt: "Update the exact target.",
    });
    const options = Object.freeze({
      call,
      requestToolResults: Object.freeze({
        sourceRevision: head.revision,
        results: Object.freeze([]),
      }),
      capabilitySource,
    });
    const callIdentity = projectWorkerDecisionCallIdentity(call);

    const decisionState = prepareWorkerCanonicalState(
      request,
      options,
      callIdentity,
      WORKER_DECISION_MODEL_STEP,
      false,
    );
    const pendingRefinementState = prepareWorkerCanonicalState(
      request,
      options,
      callIdentity,
      CAPABILITY_CONTROLS_MODEL_STEP,
      true,
    );

    expect(decisionState.operationSupervision).toEqual([
      expect.objectContaining({
        stage: "warning",
        actionFingerprint: ACTION_FINGERPRINT,
      }),
    ]);
    expect(pendingRefinementState.operationSupervision).toBeUndefined();
  });
});

async function createWarningLedger(
  owner: "root" | "worker",
): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId: `operation-supervision-topology-${owner}`,
    policy: {
      authority: authorityFor(owner),
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
  if (owner === "worker") {
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Update one exact target.",
      workerCapabilityScope: { catalogGroupIds: ["files"] },
    });
  }
  await commitObservation(ledger);
  await commitObservation(ledger);
  return ledger;
}

async function createReconsiderationLedger(): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId: "reconsideration-topology-root",
    policy: {
      authority: authorityFor("root"),
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
  await commit(ledger, {
    authority: "active_role",
    type: "reconsider_capability_selection",
    callId: "call-1",
    invocationAttempt: 2,
    steeringVersion: 0,
    selection: {
      action: "invoke_capability",
      invocations: [
        {
          capabilityId: "files.write",
          intent: "Write the exact target.",
          selectionControlsJson: '{"path":"target.txt"}',
        },
      ],
      workingDirectory: ".",
      activeCapabilityCatalogGroupIds: ["files"],
    },
    cause: {
      kind: "refinement_declined",
      entries: [
        {
          invocationIndex: 0,
          reason: "The selected capability does not apply.",
        },
      ],
    },
  });
  return ledger;
}

async function commitObservation(ledger: RoleCallLedger): Promise<void> {
  const call = requireActiveCall(ledger);
  const begun = await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "files.read",
    declaredEffect: "observation",
    intent: "Read one exact target.",
    controlsJson: JSON.stringify({ path: "target.txt" }),
    actionFingerprint: ACTION_FINGERPRINT,
  });
  const execution = begun.state.capabilityExecutions.at(-1);
  if (!execution) throw new Error("capability execution missing");
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: execution.executionId,
    outcome: "succeeded",
    observedEffect: "observation",
    summary: "Observed the exact target.",
    exactResult: exactResult(),
    outcomeFingerprint: OUTCOME_FINGERPRINT,
  });
}

function createBinding(
  ledger: RoleCallLedger,
  call: RoleCallFrame,
): Pick<
  WorkerCapabilityBinding<unknown>,
  "requestId" | "ledger" | "callId" | "invocationAttempt" | "capabilities"
> {
  return Object.freeze({
    requestId: ledger.current().state.requestId,
    ledger,
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilities: Object.freeze([]),
  });
}

function authorityFor(
  owner: "root" | "worker",
): ExecutionPolicyAuthoritySnapshot {
  if (owner === "worker") return SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT;
  return Object.freeze({
    id: "execution-agent-v1",
    version: 1,
    definitionHash: `sha256:${"d".repeat(64)}`,
    rootContractId: "execution_agent",
    availableSubordinateContractIds: Object.freeze(["worker"] as const),
    capabilityAuthorities: Object.freeze(["root", "worker"] as const),
  });
}

function exactResult() {
  return Object.freeze({
    kind: "generic_capability_result_v1" as const,
    authority: "capability_adapter" as const,
    status: "executed" as const,
    ok: true,
    payload: EXACT_PAYLOAD,
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

async function commit(ledger: RoleCallLedger, command: unknown) {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}

function parseStateMessage(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}
