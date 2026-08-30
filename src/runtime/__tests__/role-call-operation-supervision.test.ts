import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import {
  assessRoleOperationSupervisionAttempt,
  createRoleCallLedger,
  requireRoleCallOperationSupervisionInterventionCommit,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
  validateRoleCallCandidate,
  type RoleCallLedger,
  type RoleCallLedgerCommit,
  type RoleCallLedgerHead,
  type RoleCallPolicy,
} from "../orchestration/role-calls/index.js";

const FINGERPRINT_A = `sha256:${"a".repeat(64)}`;
const FINGERPRINT_B = `sha256:${"b".repeat(64)}`;
const FAILURE_FINGERPRINT_A = `sha256:${"d".repeat(64)}`;
const FAILURE_FINGERPRINT_B = `sha256:${"e".repeat(64)}`;

beforeEach(() => {
  configureDebugLogger({ enabled: false });
});

afterEach(() => {
  resetDebugLoggerConfig();
});

describe("canonical operation supervision", () => {
  test("warns after a repeated success, intervenes without execution, then rejects insistence", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });

    const firstExecutionId = await executeSingle(
      ledger,
      observationAttempt(FINGERPRINT_A),
    );
    expect(ledger.current().state.operationSupervision.entries).toEqual([
      {
        stage: "tracking",
        capabilityId: "files.read",
        actionFingerprint: FINGERPRINT_A,
        priorOutcome: "succeeded",
        outcomeFingerprint: "succeeded",
        originExecutionId: firstExecutionId,
        matchingOutcomeCount: 1,
      },
    ]);
    expect(ledger.current().state.operationSupervision.interventions).toEqual(
      [],
    );

    const secondExecutionId = await executeSingle(
      ledger,
      observationAttempt(FINGERPRINT_A),
    );
    expect(ledger.current().state.operationSupervision.entries).toEqual([
      {
        stage: "warning",
        capabilityId: "files.read",
        actionFingerprint: FINGERPRINT_A,
        priorOutcome: "succeeded",
        outcomeFingerprint: "succeeded",
        originExecutionId: secondExecutionId,
        matchingOutcomeCount: 2,
      },
    ]);

    const beforeIntervention = ledger.current();
    const previousExecutionCount =
      beforeIntervention.state.capabilityExecutions.length;
    const call = activeCall(beforeIntervention);
    const result = await ledger.transactions!.beginCapabilityExecution({
      expectedHead: beforeIntervention,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      ...observationAttempt(FINGERPRINT_A),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issueCode);
    const intervention = requireRoleCallOperationSupervisionInterventionCommit(
      result.commit,
    );
    expect(intervention.effect).toEqual({
      type: "operation_supervision_intervened",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      capabilityId: "files.read",
      actionFingerprint: FINGERPRINT_A,
      priorOutcome: "succeeded",
      outcomeFingerprint: "succeeded",
      originExecutionId: secondExecutionId,
      matchingOutcomeCount: 2,
      interventionCount: 1,
    });
    expect(intervention.head.state.capabilityExecutions).toHaveLength(
      previousExecutionCount,
    );
    expect(activeCall(intervention.head).activationCount).toBe(
      call.activationCount + 1,
    );
    expect(intervention.head.state.operationSupervision.interventions).toEqual([
      {
        capabilityId: "files.read",
        actionFingerprint: FINGERPRINT_A,
        priorOutcome: "succeeded",
        outcomeFingerprint: "succeeded",
        originExecutionId: secondExecutionId,
        matchingOutcomeCount: 2,
        interventionCount: 1,
        interventionCallId: call.callId,
        interventionInvocationAttempt: call.activationCount,
      },
    ]);

    const beforeRejectedAttempt = ledger.current();
    const active = activeCall(beforeRejectedAttempt);
    expect(
      await ledger.apply({
        expectedHead: beforeRejectedAttempt,
        command: {
          authority: "active_role",
          type: "begin_capability_execution",
          callId: active.callId,
          invocationAttempt: active.activationCount,
          ...observationAttempt(FINGERPRINT_A),
        },
      }),
    ).toMatchObject({
      ok: false,
      status: "rejected",
      code: "operation_supervision_limit_exceeded",
      head: beforeRejectedAttempt,
    });
    expect(ledger.current()).toBe(beforeRejectedAttempt);
  });

  test("supervises repeated failures with the same non-failing intervention", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });

    await executeSingle(
      ledger,
      mutationAttempt(FINGERPRINT_A),
      "failed",
      "none",
    );
    const secondExecutionId = await executeSingle(
      ledger,
      mutationAttempt(FINGERPRINT_A),
      "failed",
      "none",
    );

    const before = ledger.current();
    const call = activeCall(before);
    const result = await ledger.transactions!.beginCapabilityExecution({
      expectedHead: before,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      ...mutationAttempt(FINGERPRINT_A),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issueCode);
    expect(result.commit.effect).toMatchObject({
      type: "operation_supervision_intervened",
      priorOutcome: "failed",
      outcomeFingerprint: FAILURE_FINGERPRINT_A,
      originExecutionId: secondExecutionId,
      actionFingerprint: FINGERPRINT_A,
    });
    expect(activeCall(result.commit.head).status).toBe("active");
  });

  test("opens a new supervision epoch after a successful observed mutation", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));

    const warned = ledger.current();
    const call = activeCall(warned);
    const intervention = await ledger.transactions!.beginCapabilityExecution({
      expectedHead: warned,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      ...observationAttempt(FINGERPRINT_A),
    });
    expect(intervention.ok).toBe(true);
    if (!intervention.ok) throw new Error(intervention.issueCode);
    expect(intervention.commit.effect.type).toBe(
      "operation_supervision_intervened",
    );
    const staleSupervision =
      intervention.commit.head.state.operationSupervision;

    await executeSingle(ledger, mutationAttempt(FINGERPRINT_B));
    const resetHead = ledger.current();
    expect(resetHead.state.operationSupervision).toEqual({
      entries: [],
      interventions: [],
    });
    expect(
      validateRoleCallCandidate({
        state: resetHead.state,
        policy: resetHead.policy,
      }),
    ).toEqual([]);
    expect(
      validateRoleCallCandidate({
        state: {
          ...resetHead.state,
          operationSupervision: staleSupervision,
        },
        policy: resetHead.policy,
      }),
    ).toContainEqual({
      code: "invalid_role_operation_supervision",
      path: "state.operationSupervision",
    });

    await executeSingle(ledger, mutationAttempt(FINGERPRINT_B));
    expect(ledger.current().state.operationSupervision).toEqual({
      entries: [],
      interventions: [],
    });

    const nextObservationId = await executeSingle(
      ledger,
      observationAttempt(FINGERPRINT_A),
    );
    expect(ledger.current().state.operationSupervision.entries).toEqual([
      {
        stage: "tracking",
        capabilityId: "files.read",
        actionFingerprint: FINGERPRINT_A,
        priorOutcome: "succeeded",
        outcomeFingerprint: "succeeded",
        originExecutionId: nextObservationId,
        matchingOutcomeCount: 1,
      },
    ]);
  });

  test("does not reset supervision after a failed observed mutation", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));

    await executeSingle(
      ledger,
      mutationAttempt(FINGERPRINT_B),
      "failed",
      "mutation",
      FAILURE_FINGERPRINT_A,
    );

    expect(ledger.current().state.operationSupervision.entries).toMatchObject([
      {
        stage: "warning",
        capabilityId: "files.read",
        actionFingerprint: FINGERPRINT_A,
        matchingOutcomeCount: 2,
      },
      {
        stage: "tracking",
        capabilityId: "files.write",
        actionFingerprint: FINGERPRINT_B,
        priorOutcome: "failed",
        matchingOutcomeCount: 1,
      },
    ]);
  });

  test("uses the observed mutation from a mixed capability as the epoch boundary", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));

    await executeSingle(ledger, mixedAttempt(), "succeeded", "mutation");

    expect(ledger.current().state.operationSupervision).toEqual({
      entries: [],
      interventions: [],
    });
  });

  test("keeps independent fingerprints so A-B-A cannot bypass supervision", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });

    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));
    await executeSingle(ledger, observationAttempt(FINGERPRINT_B));

    expect(ledger.current().state.operationSupervision.entries).toMatchObject([
      {
        stage: "warning",
        actionFingerprint: FINGERPRINT_A,
        matchingOutcomeCount: 2,
      },
      {
        stage: "tracking",
        actionFingerprint: FINGERPRINT_B,
        matchingOutcomeCount: 1,
      },
    ]);

    const before = ledger.current();
    const call = activeCall(before);
    const result = await ledger.transactions!.beginCapabilityExecution({
      expectedHead: before,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      ...observationAttempt(FINGERPRINT_A),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issueCode);
    expect(result.commit.effect.type).toBe("operation_supervision_intervened");
    expect(
      result.commit.head.state.operationSupervision.entries[1],
    ).toMatchObject({
      stage: "tracking",
      actionFingerprint: FINGERPRINT_B,
    });
  });

  test("tracks outcomes independently and leaves state unchanged for untracked actions", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });

    await executeSingle(
      ledger,
      observationAttempt(FINGERPRINT_A),
      "failed",
      "none",
    );
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));
    expect(
      ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({
      stage: "tracking",
      priorOutcome: "succeeded",
      matchingOutcomeCount: 1,
    });

    await executeSingle(ledger, observationAttempt());
    expect(ledger.current().state.operationSupervision.entries).toHaveLength(1);

    await executeSingle(
      ledger,
      observationAttempt(FINGERPRINT_B),
      "succeeded",
      "observation",
      null,
    );
    expect(ledger.current().state.operationSupervision.entries).toHaveLength(1);

    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));
    expect(
      ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({
      stage: "warning",
      priorOutcome: "succeeded",
      matchingOutcomeCount: 2,
    });
  });

  test("does not treat distinct failure fingerprints as the same failure", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });

    await executeSingle(
      ledger,
      observationAttempt(FINGERPRINT_A),
      "failed",
      "none",
      FAILURE_FINGERPRINT_A,
    );
    await executeSingle(
      ledger,
      observationAttempt(FINGERPRINT_A),
      "failed",
      "none",
      FAILURE_FINGERPRINT_B,
    );

    expect(ledger.current().state.operationSupervision.entries).toMatchObject([
      {
        stage: "tracking",
        actionFingerprint: FINGERPRINT_A,
        priorOutcome: "failed",
        outcomeFingerprint: FAILURE_FINGERPRINT_B,
        matchingOutcomeCount: 1,
      },
    ]);
  });

  test("applies one atomic supervision decision to a unique batch", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });

    await executeObservationBatch(ledger);
    await executeObservationBatch(ledger);
    expect(ledger.current().state.operationSupervision.entries).toMatchObject([
      {
        stage: "warning",
        actionFingerprint: FINGERPRINT_A,
        priorOutcome: "succeeded",
      },
      {
        stage: "warning",
        actionFingerprint: FINGERPRINT_B,
        priorOutcome: "failed",
      },
    ]);

    const before = ledger.current();
    const call = activeCall(before);
    const result = await ledger.transactions!.beginCapabilityBatch({
      expectedHead: before,
      callId: call.callId,
      invocationAttempt: call.activationCount,
      entries: observationBatchEntries(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issueCode);
    expect(result.commit.effect).toMatchObject({
      type: "operation_supervision_intervened",
      actionFingerprint: FINGERPRINT_A,
      priorOutcome: "succeeded",
      outcomeFingerprint: "succeeded",
    });
    expect(result.commit.head.state.capabilityExecutions).toHaveLength(
      before.state.capabilityExecutions.length,
    );
    expect(
      result.commit.head.state.operationSupervision.entries[1],
    ).toMatchObject({
      stage: "warning",
      actionFingerprint: FINGERPRINT_B,
    });
  });

  test("rejects structurally perfect intervention evidence forged over a child activation", async () => {
    const ledger = createRootCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));

    const warned = ledger.current();
    const root = activeCall(warned);
    const forgedInvocationAttempt = root.activationCount;
    await openWorker(ledger, "Perform an unrelated bounded child task.");
    await returnActiveWorker(ledger);

    const resumed = ledger.current();
    const warning = resumed.state.operationSupervision.entries[0];
    if (warning?.stage !== "warning") {
      throw new Error("operation supervision warning missing");
    }
    const forgedDecision = assessRoleOperationSupervisionAttempt({
      state: resumed.state.operationSupervision,
      callId: root.callId,
      invocationAttempt: forgedInvocationAttempt,
      capabilityId: warning.capabilityId,
      actionFingerprint: warning.actionFingerprint,
    });
    if (forgedDecision.disposition !== "intervene") {
      throw new Error("forged operation supervision decision missing");
    }
    const forgedState = {
      ...resumed.state,
      operationSupervision: forgedDecision.state,
    };

    expect(
      resumed.state.capabilityExecutions.some(
        (execution) =>
          execution.callId === root.callId &&
          execution.invocationAttempt === forgedInvocationAttempt,
      ),
    ).toBe(false);
    expect(
      validateRoleCallCandidate({
        state: forgedState,
        policy: resumed.policy,
      }),
    ).toContainEqual({
      code: "invalid_role_operation_supervision",
      path: "state.operationSupervision",
    });
  });

  test("preserves supervision across role-call boundaries and rejects forged intervention evidence", async () => {
    const ledger = createDelegatedCapabilityLedger();
    await applyCommitted(ledger, { authority: "runtime", type: "create_root" });
    await openWorker(ledger, "Observe the first bounded target.");
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));
    await executeSingle(ledger, observationAttempt(FINGERPRINT_A));
    await returnActiveWorker(ledger);
    await openWorker(ledger, "Continue the bounded observation.");

    const before = ledger.current();
    const worker = activeCall(before);
    const result = await ledger.transactions!.beginCapabilityExecution({
      expectedHead: before,
      callId: worker.callId,
      invocationAttempt: worker.activationCount,
      ...observationAttempt(FINGERPRINT_A),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issueCode);
    expect(result.commit.effect.type).toBe("operation_supervision_intervened");

    const valid = result.commit.head.state;
    const intervention = valid.operationSupervision.interventions[0]!;
    expect(
      validateRoleCallCandidate({
        state: valid,
        policy: result.commit.head.policy,
      }),
    ).toEqual([]);
    expect(
      validateRoleCallCandidate({
        state: { ...valid, requestId: `${valid.requestId}-other` },
        policy: result.commit.head.policy,
      }),
    ).toContainEqual({
      code: "invalid_role_operation_supervision",
      path: "state.operationSupervision",
    });
    const executedAttempt = valid.capabilityExecutions[0]!;
    const forgedIntervention = {
      ...intervention,
      interventionCallId: executedAttempt.callId,
      interventionInvocationAttempt: executedAttempt.invocationAttempt,
    };
    const invalidSupervisionStates = [
      {
        operationSupervision: {
          ...valid.operationSupervision,
          interventions: [],
        },
        expectedIssue: {
          code: "invalid_role_operation_supervision",
          path: "state.operationSupervision",
        },
      },
      {
        operationSupervision: {
          ...valid.operationSupervision,
          interventions: [
            { ...intervention, originExecutionId: "execution-forged" },
          ],
        },
        expectedIssue: {
          code: "invalid_role_operation_supervision",
          path: "state.operationSupervision",
        },
      },
      {
        operationSupervision: {
          ...valid.operationSupervision,
          entries: valid.operationSupervision.entries.map((entry) =>
            entry.stage === "intervened"
              ? { stage: "intervened" as const, ...forgedIntervention }
              : entry,
          ),
          interventions: [forgedIntervention],
        },
        expectedIssue: {
          code: "invalid_role_operation_supervision",
          path: "state.operationSupervision",
        },
      },
      {
        operationSupervision: {
          ...valid.operationSupervision,
          interventions: [intervention, { ...intervention }],
        },
        expectedIssue: {
          code: "invalid_role_call_state_shape",
          path: "state",
        },
      },
      {
        operationSupervision: {
          ...valid.operationSupervision,
          entries: valid.operationSupervision.entries.map((entry) => ({
            ...entry,
            originExecutionId: "execution-forged",
          })),
        },
        expectedIssue: {
          code: "invalid_role_operation_supervision",
          path: "state.operationSupervision",
        },
      },
    ];
    for (const {
      operationSupervision,
      expectedIssue,
    } of invalidSupervisionStates) {
      expect(
        validateRoleCallCandidate({
          state: { ...valid, operationSupervision },
          policy: result.commit.head.policy,
        }),
      ).toContainEqual(expectedIssue);
    }
  });
});

function createRootCapabilityLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "root-operation-supervision-request",
    policy: {
      authority: {
        id: "execution-agent-v1",
        version: 1,
        definitionHash: `sha256:${"c".repeat(64)}`,
        rootContractId: "execution_agent",
        availableSubordinateContractIds: ["worker"],
        capabilityAuthorities: ["root", "worker"],
      },
      limits: policyLimits(),
    },
  });
}

function createDelegatedCapabilityLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "delegated-operation-supervision-request",
    policy: {
      authority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
      limits: policyLimits(),
    },
  });
}

function policyLimits(): RoleCallPolicy["limits"] {
  return {
    maxDepth: 4,
    maxCalls: 8,
    maxCapabilityExecutions: 16,
    maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
    maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
    maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
  };
}

function observationAttempt(actionFingerprint?: string) {
  return {
    capabilityId: "files.read",
    declaredEffect: "observation" as const,
    intent: "Read the bounded target.",
    controlsJson: '{"path":"news.txt","startLine":1,"endLine":20}',
    ...(actionFingerprint ? { actionFingerprint } : {}),
  };
}

function mutationAttempt(actionFingerprint?: string) {
  return {
    capabilityId: "files.write",
    declaredEffect: "mutation" as const,
    intent: "Write the bounded target.",
    controlsJson: '{"path":"news.txt","content":"bounded"}',
    ...(actionFingerprint ? { actionFingerprint } : {}),
  };
}

function mixedAttempt(actionFingerprint?: string) {
  return {
    capabilityId: "files.transform",
    declaredEffect: "mixed" as const,
    intent: "Transform the bounded target.",
    controlsJson: '{"path":"news.txt","content":"bounded"}',
    ...(actionFingerprint ? { actionFingerprint } : {}),
  };
}

function observationBatchEntries() {
  return [
    {
      ...observationAttempt(FINGERPRINT_A),
      controlsJson: '{"path":"news.txt","startLine":1,"endLine":20}',
    },
    {
      ...observationAttempt(FINGERPRINT_B),
      controlsJson: '{"path":"news.txt","startLine":21,"endLine":40}',
    },
  ] as const;
}

async function executeObservationBatch(ledger: RoleCallLedger): Promise<void> {
  const before = ledger.current();
  const call = activeCall(before);
  const begun = await applyCommitted(ledger, {
    authority: "active_role",
    type: "begin_capability_batch",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    entries: observationBatchEntries(),
  });
  if (begun.effect.type !== "capability_batch_begun") {
    throw new Error("expected capability batch");
  }
  await applyCommitted(ledger, {
    authority: "runtime",
    type: "settle_capability_batch",
    callId: call.callId,
    settlements: [
      {
        executionId: begun.effect.executionIds[0],
        outcome: "succeeded",
        outcomeFingerprint: "succeeded",
        observedEffect: "observation",
        summary: "Observed the first bounded range.",
        exactResult: capabilityResult("succeeded", "observation"),
      },
      {
        executionId: begun.effect.executionIds[1],
        outcome: "failed",
        outcomeFingerprint: FAILURE_FINGERPRINT_A,
        observedEffect: "none",
        summary: "The second bounded range failed.",
        exactResult: capabilityResult("failed", "none"),
      },
    ],
  });
}

async function executeSingle(
  ledger: RoleCallLedger,
  attempt:
    | ReturnType<typeof mutationAttempt>
    | ReturnType<typeof observationAttempt>
    | ReturnType<typeof mixedAttempt>,
  outcome: "succeeded" | "failed" = "succeeded",
  observedEffect:
    | "none"
    | "observation"
    | "mutation" = attempt.declaredEffect === "mixed"
    ? "observation"
    : attempt.declaredEffect,
  outcomeFingerprint: string | null = outcome === "succeeded"
    ? "succeeded"
    : FAILURE_FINGERPRINT_A,
): Promise<string> {
  const before = ledger.current();
  const call = activeCall(before);
  const begun = await applyCommitted(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    ...attempt,
  });
  expect(begun.effect.type).toBe("capability_execution_begun");
  if (begun.effect.type !== "capability_execution_begun") {
    throw new Error("expected capability execution");
  }
  await applyCommitted(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: begun.effect.executionId,
    outcome,
    ...(outcomeFingerprint ? { outcomeFingerprint } : {}),
    observedEffect,
    summary: "Settled the bounded operation.",
    exactResult: capabilityResult(outcome, observedEffect),
  });
  return begun.effect.executionId;
}

async function openWorker(ledger: RoleCallLedger, objective: string) {
  const root = activeCall(ledger.current());
  await applyCommitted(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: root.callId,
    roleId: "worker",
    objective,
    workerCapabilityScope: { catalogGroupIds: ["filesystem"] },
  });
}

async function returnActiveWorker(ledger: RoleCallLedger) {
  const worker = activeCall(ledger.current());
  await applyCommitted(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId: worker.parentCallId,
    childCallId: worker.callId,
    outcome: "completed",
    summary: "Completed the bounded operation attempt.",
  });
}

function activeCall(head: RoleCallLedgerHead) {
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

function capabilityResult(
  outcome: "succeeded" | "failed",
  observedEffect: "none" | "observation" | "mutation",
) {
  return {
    kind: "generic_capability_result_v1" as const,
    authority: "capability_adapter" as const,
    status: "executed" as const,
    ok: outcome === "succeeded",
    payload: {
      outcome,
      observedEffect,
      summary: "Settled the bounded operation.",
    },
  };
}
