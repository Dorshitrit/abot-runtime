import { describe, expect, test } from "vitest";

import {
  createRoleCallLedger,
  isRoleCapabilitySelectionSupervisionState,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  validateRoleCallCandidate,
  type RoleCallLedger,
  type RoleCallLedgerCommit,
  type RoleCallLedgerHead,
  type RoleCapabilitySelectionProjection,
  type RoleCapabilitySelectionReconsiderationCause,
} from "../orchestration/role-calls/index.js";

const ACTION_FINGERPRINT = `sha256:${"a".repeat(64)}`;

describe("capability-selection supervision ledger integration", () => {
  test("preserves A-B-A identity and cause history, then atomically rejects the fourth A", async () => {
    const ledger = await createReadyLedger();
    const accepted = [
      {
        capabilityId: "memory.list",
        intent: "List the first bounded page.",
        cause: declinedCause("The first wording was declined."),
      },
      {
        capabilityId: "memory.delete",
        intent: "Delete the selected entry.",
        cause: invalidOutputCause("controls_schema"),
      },
      {
        capabilityId: "memory.list",
        intent: "Read a bounded page of memories.",
        cause: declinedCause("The second wording was declined."),
      },
      {
        capabilityId: "memory.list",
        intent: "Fetch one bounded memory page.",
        cause: invalidOutputCause("refinement_contract"),
      },
    ] as const;
    const causeKinds: string[] = [];

    for (const candidate of accepted) {
      const commit = await reconsider(ledger, {
        selection: singleSelection(candidate.capabilityId, candidate.intent),
        cause: candidate.cause,
      });
      const call = activeCall(commit.head);
      causeKinds.push(
        call.lastCapabilitySelectionReconsideration?.cause.kind ?? "missing",
      );
    }

    const records =
      ledger.current().state.capabilitySelectionSupervision.records;
    expect(records.map(({ identityCount }) => identityCount)).toEqual([
      1, 1, 2, 3,
    ]);
    expect(causeKinds).toEqual([
      "refinement_declined",
      "refinement_invalid_output",
      "refinement_declined",
      "refinement_invalid_output",
    ]);
    expect(
      new Set(
        [records[0], records[2], records[3]].map(
          ({ supervisionFingerprint }) => supervisionFingerprint,
        ),
      ).size,
    ).toBe(1);
    expect(
      new Set(
        [records[0], records[2], records[3]].map(
          ({ receiptFingerprint }) => receiptFingerprint,
        ),
      ).size,
    ).toBe(3);

    const before = ledger.current();
    const call = activeCall(before);
    const rejected = await ledger.apply({
      expectedHead: before,
      command: reconsiderCommand({
        call,
        selection: singleSelection(
          "memory.list",
          "List one final bounded memory page.",
        ),
        cause: declinedCause("A fourth equivalent selection was declined."),
      }),
    });

    expect(rejected).toMatchObject({
      ok: false,
      status: "rejected",
      code: "capability_selection_supervision_limit_exceeded",
      issues: [
        {
          code: "capability_selection_repeat_limit_exceeded",
          path: "state.capabilitySelectionSupervision",
        },
      ],
    });
    expect(rejected.head).toBe(before);
    expect(ledger.current()).toBe(before);
    expect(
      ledger.current().state.capabilitySelectionSupervision.records,
    ).toHaveLength(4);
    expect(activeCall(ledger.current()).activationCount).toBe(
      call.activationCount,
    );
  });

  test("atomically rejects the eighth unique selection in one no-progress epoch", async () => {
    const ledger = await createReadyLedger();
    for (let index = 1; index <= 7; index += 1) {
      await reconsider(ledger, {
        selection: singleSelection(
          `memory.choice-${index}`,
          `Inspect bounded choice ${index}.`,
        ),
        cause: declinedCause(`Choice ${index} was declined.`),
      });
    }
    expect(
      ledger
        .current()
        .state.capabilitySelectionSupervision.records.map(
          ({ totalCount, stage }) => [totalCount, stage],
        ),
    ).toEqual([
      [1, "tracking"],
      [2, "tracking"],
      [3, "tracking"],
      [4, "tracking"],
      [5, "tracking"],
      [6, "warning"],
      [7, "intervened"],
    ]);

    const before = ledger.current();
    const rejected = await ledger.apply({
      expectedHead: before,
      command: reconsiderCommand({
        call: activeCall(before),
        selection: singleSelection(
          "memory.choice-8",
          "Inspect bounded choice 8.",
        ),
        cause: declinedCause("Choice 8 was declined."),
      }),
    });

    expect(rejected).toMatchObject({
      ok: false,
      status: "rejected",
      code: "capability_selection_supervision_limit_exceeded",
      issues: [
        {
          code: "capability_selection_total_limit_exceeded",
          path: "state.capabilitySelectionSupervision",
        },
      ],
    });
    expect(rejected.head).toBe(before);
    expect(ledger.current()).toBe(before);
  });

  test("starts a fresh epoch when steering advances", async () => {
    const ledger = await createReadyLedger();
    for (let index = 1; index <= 3; index += 1) {
      await reconsider(ledger, {
        selection: singleSelection(
          "memory.list",
          `Equivalent wording ${index}.`,
        ),
        cause: declinedCause(`Decline ${index}.`),
      });
    }
    expect(
      ledger.current().state.capabilitySelectionSupervision.records.at(-1),
    ).toMatchObject({ identityCount: 3, stage: "intervened" });

    const commit = await reconsider(ledger, {
      steeringVersion: 1,
      selection: singleSelection("memory.list", "Steered wording."),
      cause: declinedCause("The steered selection was declined."),
    });

    expect(commit.effect).toMatchObject({
      type: "capability_selection_reconsidered",
      matchingSelectionCount: 1,
      totalReconsiderationCount: 1,
      supervisionStage: "tracking",
    });
    expect(commit.head.state.capabilitySelectionSupervision).toMatchObject({
      epoch: { callId: "call-1", steeringVersion: 1 },
      records: [{ identityCount: 1, totalCount: 1, stage: "tracking" }],
    });
  });

  test("rejects syntactically replayable but unissued historical records", async () => {
    const ledger = await createReadyLedger();
    for (let index = 1; index <= 3; index += 1) {
      await reconsider(ledger, {
        selection: singleSelection(
          "memory.list",
          `Equivalent wording ${index}.`,
        ),
        cause: declinedCause(`Decline ${index}.`),
      });
    }
    const head = ledger.current();
    const cloned = structuredClone(head.state);
    const forged = {
      ...cloned,
      capabilitySelectionSupervision: {
        epoch: cloned.capabilitySelectionSupervision.epoch,
        records: cloned.capabilitySelectionSupervision.records.map(
          (record, index) => ({
            ...record,
            supervisionFingerprint:
              index === 2
                ? record.supervisionFingerprint
                : `sha256:${String(index + 1).repeat(64)}`,
            identityCount: 1,
            stage: "tracking" as const,
            trigger: "repeat_identity" as const,
          }),
        ),
      },
    };
    expect(
      isRoleCapabilitySelectionSupervisionState(
        forged.capabilitySelectionSupervision,
      ),
    ).toBe(true);

    expect(
      validateRoleCallCandidate({ state: forged, policy: head.policy }),
    ).toContainEqual({
      code: "invalid_role_capability_selection_supervision",
      path: "state.capabilitySelectionSupervision",
    });
  });

  test("rejects a record issued by another ledger with the same request id", async () => {
    const sourceLedger = await createReadyLedger();
    const targetLedger = await createReadyLedger();
    const selection = singleSelection(
      "memory.list",
      "Inspect one bounded page.",
    );
    const cause = declinedCause("The bounded selection was declined.");
    await reconsider(sourceLedger, { selection, cause });
    await reconsider(targetLedger, { selection, cause });

    const sourceRecord =
      sourceLedger.current().state.capabilitySelectionSupervision.records[0];
    const targetHead = targetLedger.current();
    const targetRecord =
      targetHead.state.capabilitySelectionSupervision.records[0];
    expect(sourceRecord).toEqual(targetRecord);
    expect(sourceRecord).not.toBe(targetRecord);

    expect(
      validateRoleCallCandidate({
        state: {
          ...targetHead.state,
          capabilitySelectionSupervision: {
            ...targetHead.state.capabilitySelectionSupervision,
            records: [sourceRecord],
          },
        },
        policy: targetHead.policy,
      }),
    ).toContainEqual({
      code: "invalid_role_capability_selection_supervision",
      path: "state.capabilitySelectionSupervision",
    });
  });

  test("rejects a record spliced from an earlier steering epoch", async () => {
    const ledger = await createReadyLedger();
    const selection = singleSelection(
      "memory.list",
      "Inspect one bounded page.",
    );
    await reconsider(ledger, {
      selection,
      cause: declinedCause("The initial selection was declined."),
    });
    const priorEpochRecord =
      ledger.current().state.capabilitySelectionSupervision.records[0];

    await reconsider(ledger, {
      steeringVersion: 1,
      selection,
      cause: declinedCause("The steered selection was declined."),
    });
    const targetHead = ledger.current();
    expect(targetHead.state.capabilitySelectionSupervision.epoch).toEqual({
      callId: "call-1",
      steeringVersion: 1,
    });

    expect(
      validateRoleCallCandidate({
        state: {
          ...targetHead.state,
          capabilitySelectionSupervision: {
            ...targetHead.state.capabilitySelectionSupervision,
            records: [priorEpochRecord],
          },
        },
        policy: targetHead.policy,
      }),
    ).toContainEqual({
      code: "invalid_role_capability_selection_supervision",
      path: "state.capabilitySelectionSupervision",
    });
  });

  test("rejects a structurally identical record issued for another call", async () => {
    const ledger = await createReadyLedger();
    const selection = singleSelection(
      "memory.list",
      "Inspect one bounded page.",
    );
    const cause = declinedCause("The bounded selection was declined.");

    await openWorker(ledger);
    await reconsider(ledger, { selection, cause });
    const sourceHead = ledger.current();
    const sourceCall = activeCall(sourceHead);
    const sourceRecord =
      sourceHead.state.capabilitySelectionSupervision.records[0];
    await applyCommitted(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: sourceCall.callId,
      outcome: "completed",
      summary: "The first bounded child returned.",
    });

    await openWorker(ledger);
    await reconsider(ledger, { selection, cause });
    const targetHead = ledger.current();
    const targetRecord =
      targetHead.state.capabilitySelectionSupervision.records[0];
    expect(activeCall(targetHead).callId).not.toBe(sourceCall.callId);
    expect(sourceRecord).toEqual(targetRecord);
    expect(sourceRecord).not.toBe(targetRecord);

    expect(
      validateRoleCallCandidate({
        state: {
          ...targetHead.state,
          capabilitySelectionSupervision: {
            ...targetHead.state.capabilitySelectionSupervision,
            records: [sourceRecord],
          },
        },
        policy: targetHead.policy,
      }),
    ).toContainEqual({
      code: "invalid_role_capability_selection_supervision",
      path: "state.capabilitySelectionSupervision",
    });
  });

  test.each([
    ["single execution", beginSingleExecution],
    ["batch execution", beginBatchExecution],
    ["scope update", extendCapabilityScope],
    ["working-directory establishment", establishWorkingDirectory],
    ["child opening", openWorker],
  ] as const)(
    "resets after successful progress: %s",
    async (_name, progress) => {
      const ledger = await createReadyLedger();
      await reconsider(ledger, {
        selection: singleSelection("memory.list", "Inspect one bounded page."),
        cause: declinedCause("The bounded selection was declined."),
      });
      expect(
        ledger.current().state.capabilitySelectionSupervision.records,
      ).toHaveLength(1);

      const commit = await progress(ledger);

      expect(commit.head.state.capabilitySelectionSupervision).toEqual({
        epoch: null,
        records: [],
      });
    },
  );

  test("resets when post-materialization operation supervision takes ownership", async () => {
    const ledger = await createReadyLedger();
    await executeObservedRead(ledger);
    await executeObservedRead(ledger);
    expect(
      ledger.current().state.operationSupervision.entries[0],
    ).toMatchObject({
      stage: "warning",
      matchingOutcomeCount: 2,
    });
    await reconsider(ledger, {
      selection: singleSelection("files.read", "Read the bounded target."),
      cause: declinedCause("The repeated read was declined."),
    });

    const before = ledger.current();
    const call = activeCall(before);
    const intervention = await applyCommitted(ledger, {
      authority: "active_role",
      type: "begin_capability_execution",
      callId: call.callId,
      invocationAttempt: call.activationCount,
      capabilityId: "files.read",
      declaredEffect: "observation",
      intent: "Read the bounded target.",
      controlsJson: '{"path":"news.txt"}',
      actionFingerprint: ACTION_FINGERPRINT,
    });

    expect(intervention.effect.type).toBe("operation_supervision_intervened");
    expect(intervention.head.state.capabilitySelectionSupervision).toEqual({
      epoch: null,
      records: [],
    });
  });

  test("resets when a capability-authority child returns to its caller", async () => {
    const ledger = await createReadyLedger();
    const opened = await openWorker(ledger);
    expect(opened.effect.type).toBe("child_opened");
    await reconsider(ledger, {
      selection: singleSelection("memory.list", "Inspect one bounded page."),
      cause: declinedCause("The child selection was declined."),
    });
    expect(
      ledger.current().state.capabilitySelectionSupervision.records,
    ).toHaveLength(1);

    const returned = await applyCommitted(ledger, {
      authority: "runtime",
      type: "return_child",
      callerCallId: "call-1",
      childCallId: "call-2",
      outcome: "completed",
      summary: "No capability result was established.",
    });

    expect(returned.head.state.capabilitySelectionSupervision).toEqual({
      epoch: null,
      records: [],
    });
  });

  test("counts refinement_invalid_output as a no-progress reconsideration", async () => {
    const ledger = await createReadyLedger();
    const selection = singleSelection(
      "memory.list",
      "Inspect one bounded page.",
    );
    await reconsider(ledger, {
      selection,
      cause: declinedCause("The first refinement was declined."),
    });
    const second = await reconsider(ledger, {
      selection,
      cause: invalidOutputCause("refinement_schema"),
    });

    expect(second.effect).toMatchObject({
      type: "capability_selection_reconsidered",
      matchingSelectionCount: 2,
      totalReconsiderationCount: 2,
      supervisionStage: "warning",
    });
    expect(
      activeCall(second.head).lastCapabilitySelectionReconsideration?.cause,
    ).toMatchObject({
      kind: "refinement_invalid_output",
      validationStage: "refinement_schema",
    });
  });
});

async function createReadyLedger(): Promise<RoleCallLedger> {
  const ledger = createRoleCallLedger({
    requestId: "capability-selection-supervision-integration",
    policy: {
      authority: {
        id: "execution-agent-v1",
        version: 1,
        definitionHash: `sha256:${"b".repeat(64)}`,
        rootContractId: "execution_agent",
        availableSubordinateContractIds: ["worker"],
        capabilityAuthorities: ["root", "worker"],
      },
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 32,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await applyCommitted(ledger, { authority: "runtime", type: "create_root" });
  const call = activeCall(ledger.current());
  await applyCommitted(ledger, {
    authority: "active_role",
    type: "update_capability_scope",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    mode: "open",
    catalogGroupIds: ["memory"],
  });
  return ledger;
}

async function reconsider(
  ledger: RoleCallLedger,
  input: Readonly<{
    steeringVersion?: number;
    selection: RoleCapabilitySelectionProjection;
    cause: RoleCapabilitySelectionReconsiderationCause;
  }>,
): Promise<RoleCallLedgerCommit> {
  const before = ledger.current();
  return applyCommitted(
    ledger,
    reconsiderCommand({
      call: activeCall(before),
      steeringVersion: input.steeringVersion,
      selection: input.selection,
      cause: input.cause,
    }),
  );
}

function reconsiderCommand(
  input: Readonly<{
    call: ReturnType<typeof activeCall>;
    steeringVersion?: number;
    selection: RoleCapabilitySelectionProjection;
    cause: RoleCapabilitySelectionReconsiderationCause;
  }>,
) {
  return {
    authority: "active_role" as const,
    type: "reconsider_capability_selection" as const,
    callId: input.call.callId,
    invocationAttempt: input.call.activationCount,
    steeringVersion: input.steeringVersion ?? 0,
    selection: input.selection,
    cause: input.cause,
  };
}

function singleSelection(
  capabilityId: string,
  intent: string,
): RoleCapabilitySelectionProjection {
  return {
    action: "invoke_capability",
    invocations: [
      {
        capabilityId,
        intent,
        selectionControlsJson: '{"page":1}',
      },
    ],
    workingDirectory: null,
    activeCapabilityCatalogGroupIds: ["memory"],
  };
}

function declinedCause(
  reason: string,
): RoleCapabilitySelectionReconsiderationCause {
  return {
    kind: "refinement_declined",
    entries: [{ invocationIndex: 0, reason }],
  };
}

function invalidOutputCause(
  validationStage: string,
): RoleCapabilitySelectionReconsiderationCause {
  return {
    kind: "refinement_invalid_output",
    validationStage,
    issues: [{ code: "invalid_controls", path: "$.controls" }],
    repairAttempts: 1,
    repeatedInvalidOutput: false,
  };
}

async function beginSingleExecution(
  ledger: RoleCallLedger,
): Promise<RoleCallLedgerCommit> {
  const call = activeCall(ledger.current());
  return applyCommitted(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "memory.list",
    declaredEffect: "observation",
    intent: "Inspect one bounded page.",
    controlsJson: '{"page":1}',
  });
}

async function beginBatchExecution(
  ledger: RoleCallLedger,
): Promise<RoleCallLedgerCommit> {
  const call = activeCall(ledger.current());
  return applyCommitted(ledger, {
    authority: "active_role",
    type: "begin_capability_batch",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    entries: [
      {
        capabilityId: "memory.list",
        declaredEffect: "observation",
        intent: "Inspect the first bounded page.",
        controlsJson: '{"page":1}',
      },
      {
        capabilityId: "memory.status",
        declaredEffect: "observation",
        intent: "Inspect bounded memory status.",
        controlsJson: "{}",
      },
    ],
  });
}

async function extendCapabilityScope(
  ledger: RoleCallLedger,
): Promise<RoleCallLedgerCommit> {
  const call = activeCall(ledger.current());
  return applyCommitted(ledger, {
    authority: "active_role",
    type: "update_capability_scope",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    mode: "extend",
    catalogGroupIds: ["filesystem"],
  });
}

async function establishWorkingDirectory(
  ledger: RoleCallLedger,
): Promise<RoleCallLedgerCommit> {
  const call = activeCall(ledger.current());
  return applyCommitted(ledger, {
    authority: "active_role",
    type: "establish_working_directory",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    workingDirectory: ".",
  });
}

async function openWorker(
  ledger: RoleCallLedger,
): Promise<RoleCallLedgerCommit> {
  const call = activeCall(ledger.current());
  return applyCommitted(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: call.callId,
    roleId: "worker",
    objective: "Inspect one bounded target.",
    workerCapabilityScope: { catalogGroupIds: ["memory"] },
  });
}

async function executeObservedRead(ledger: RoleCallLedger): Promise<void> {
  const call = activeCall(ledger.current());
  const begun = await applyCommitted(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "files.read",
    declaredEffect: "observation",
    intent: "Read the bounded target.",
    controlsJson: '{"path":"news.txt"}',
    actionFingerprint: ACTION_FINGERPRINT,
  });
  if (begun.effect.type !== "capability_execution_begun") {
    throw new Error("Expected a materialized capability execution.");
  }
  await applyCommitted(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: begun.effect.executionId,
    outcome: "succeeded",
    outcomeFingerprint: "succeeded",
    observedEffect: "observation",
    summary: "Observed the bounded target.",
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: {
        outcome: "succeeded",
        observedEffect: "observation",
        summary: "Observed the bounded target.",
      },
    },
  });
}

function activeCall(head: RoleCallLedgerHead) {
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("Active call missing.");
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
