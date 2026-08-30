import { describe, expect, test } from "vitest";

import {
  createRoleCallLedger,
  projectImmediateRoleOperationSupervisionNotices,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerCommit,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

describe("operation supervision projection", () => {
  test("projects a warning only to the activation resumed by the repeated operation", async () => {
    const { ledger, secondExecutionId } = await createWarningFixture();
    const head = ledger.current();
    const call = currentActiveCall(head);
    expect(call).toMatchObject({ callId: "call-2", activationCount: 3 });

    expect(projectImmediateRoleOperationSupervisionNotices(head, call)).toEqual(
      [
        {
          kind: "runtime_operation_supervision_v1",
          authority: "runtime_state",
          presenceEffect: "passive_mechanical_intervention_not_user_intent",
          stage: "warning",
          actionFingerprint: FINGERPRINT,
          priorOutcome: "succeeded",
          outcomeFingerprint: "succeeded",
          originExecutionId: secondExecutionId,
          matchingOutcomeCount: 2,
          interventionCount: 0,
        },
      ],
    );
    expect(
      projectImmediateRoleOperationSupervisionNotices(head, {
        ...call,
        activationCount: 4,
      }),
    ).toEqual([]);
  });

  test("does not replay a warning when a later Worker owns the turn", async () => {
    const { ledger } = await createWarningFixture();
    const priorWorker = currentActiveCall(ledger.current());
    if (!priorWorker.parentCallId) throw new Error("worker parent missing");
    await applyCommitted(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: priorWorker.parentCallId,
      childCallId: priorWorker.callId,
      outcome: "completed",
      summary: "Completed the repeated observation.",
    });
    await openWorker(ledger);
    const head = ledger.current();
    const laterWorker = currentActiveCall(head);
    expect(laterWorker.callId).toBe("call-3");

    expect(
      projectImmediateRoleOperationSupervisionNotices(head, laterWorker),
    ).toEqual([]);
  });

  test("projects an intervention only to its exact next activation", async () => {
    const { ledger } = await createWarningFixture();
    const beforeIntervention = ledger.current();
    const warnedCall = currentActiveCall(beforeIntervention);
    const intervention = await applyCommitted(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: warnedCall.callId,
      invocationAttempt: warnedCall.activationCount,
      ...observationAttempt(),
    });
    expect(intervention.effect.type).toBe("operation_supervision_intervened");
    const head = ledger.current();
    const call = currentActiveCall(head);
    expect(call).toMatchObject({ callId: "call-2", activationCount: 4 });

    expect(
      projectImmediateRoleOperationSupervisionNotices(head, call),
    ).toMatchObject([{ stage: "intervention", interventionCount: 1 }]);
    expect(
      projectImmediateRoleOperationSupervisionNotices(head, {
        ...call,
        activationCount: 5,
      }),
    ).toEqual([]);
  });

  test("does not project tracking state or an inactive call", async () => {
    const ledger = await createActiveWorkerLedger();
    await executeObservation(ledger);
    const trackingHead = ledger.current();
    const call = currentActiveCall(trackingHead);
    expect(call).toMatchObject({ callId: "call-2", activationCount: 2 });
    expect(
      projectImmediateRoleOperationSupervisionNotices(trackingHead, call),
    ).toEqual([]);
    expect(
      projectImmediateRoleOperationSupervisionNotices(trackingHead, {
        ...call,
        status: "completed",
      }),
    ).toEqual([]);
  });
});

async function createWarningFixture(): Promise<
  Readonly<{ ledger: RoleCallLedger; secondExecutionId: string }>
> {
  const ledger = await createActiveWorkerLedger();
  await executeObservation(ledger);
  const secondExecutionId = await executeObservation(ledger);
  return Object.freeze({ ledger, secondExecutionId });
}

async function createActiveWorkerLedger(): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId: "projection-request",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
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
  await applyCommitted(ledger, { authority: "runtime", type: "create_root" });
  await openWorker(ledger);
  return ledger;
}

async function openWorker(ledger: RoleCallLedger): Promise<void> {
  const caller = currentActiveCall(ledger.current());
  await applyCommitted(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: caller.callId,
    roleId: "worker",
    objective: "Inspect one target.",
    workerCapabilityScope: { catalogGroupIds: ["filesystem"] },
  });
}

function observationAttempt() {
  return {
    capabilityId: "files.read",
    declaredEffect: "observation" as const,
    intent: "Read one bounded target.",
    controlsJson: "{}",
    actionFingerprint: FINGERPRINT,
  };
}

async function executeObservation(ledger: RoleCallLedger): Promise<string> {
  const call = currentActiveCall(ledger.current());
  const begun = await applyCommitted(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    ...observationAttempt(),
  });
  if (begun.effect.type !== "capability_execution_begun") {
    throw new Error("expected capability execution");
  }
  await applyCommitted(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: begun.effect.executionId,
    outcome: "succeeded",
    outcomeFingerprint: "succeeded",
    observedEffect: "observation",
    summary: "Read one bounded target.",
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { summary: "Read one bounded target." },
    },
  });
  return begun.effect.executionId;
}

function currentActiveCall(head: RoleCallLedgerHead): RoleCallFrame {
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("active call missing");
  return call;
}

async function applyCommitted(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerCommit> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(result).toMatchObject({ ok: true, status: "committed" });
  return result;
}
