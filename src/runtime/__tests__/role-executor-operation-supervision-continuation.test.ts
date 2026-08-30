import { describe, expect, test, vi } from "vitest";

import {
  createRoleCallLedger,
  requireRoleCallOperationSupervisionInterventionCommit,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerCommand,
  type RoleCallLedgerHead,
  type RoleCallOperationSupervisionInterventionCommit,
} from "../orchestration/role-calls/index.js";
import {
  createRoleExecutorRegistry,
  type RoleExecutorActivationResult,
  type RoleExecutorInput,
} from "../orchestration/role-executors/index.js";
import { validateOperationSupervisionInterventionContinuation } from "../orchestration/role-executors/activation/state-validation.js";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const FAILURE_FINGERPRINT = `sha256:${"d".repeat(64)}`;

describe("role executor operation-supervision intervention continuation", () => {
  test("continues the Worker after the exact canonical no-execution transition", async () => {
    const authority = await createWarningLedger("request-supervision-continue");
    const executionCountBefore =
      authority.ledger.current().state.capabilityExecutions.length;
    const execute = vi.fn(async (input: RoleExecutorInput<unknown>) => {
      if (input.call.activationCount === 3) {
        expect(input.continuation).toBeUndefined();
        const commit = await intervene(input.ledger, input.call);
        return {
          kind: "continue" as const,
          continuation: {
            kind: "operation_supervision_intervention" as const,
            commit,
          },
        };
      }
      expect(input.call.activationCount).toBe(4);
      expect(input.continuation).toBeUndefined();
      return {
        kind: "terminal" as const,
        outcome: "completed" as const,
        summary: "Selected a different strategy.",
      };
    });
    const registry = createRoleExecutorRegistry([
      { roleId: "worker", execute },
    ]);

    await expect(
      registry.execute({
        requestId: "request-supervision-continue",
        context: {},
        call: authority.call,
        ledger: authority.ledger,
      }),
    ).resolves.toEqual({
      kind: "terminal",
      outcome: "completed",
      summary: "Selected a different strategy.",
    });

    const head = authority.ledger.current();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(head.revision).toBe(authority.head.revision + 1);
    expect(head.state.capabilityExecutions).toHaveLength(executionCountBefore);
    expect(head.state.capabilityExecutionSequence).toBe(executionCountBefore);
    expect(head.state.operationSupervision.entries).toEqual([
      {
        stage: "intervened",
        capabilityId: "example.mutate",
        actionFingerprint: FINGERPRINT,
        priorOutcome: "failed",
        outcomeFingerprint: FAILURE_FINGERPRINT,
        originExecutionId: "capability-execution-2",
        matchingOutcomeCount: 2,
        interventionCount: 1,
        interventionCallId: authority.call.callId,
        interventionInvocationAttempt: 3,
      },
    ]);
    expect(head.state.operationSupervision.interventions).toEqual([
      {
        capabilityId: "example.mutate",
        actionFingerprint: FINGERPRINT,
        priorOutcome: "failed",
        outcomeFingerprint: FAILURE_FINGERPRINT,
        originExecutionId: "capability-execution-2",
        matchingOutcomeCount: 2,
        interventionCount: 1,
        interventionCallId: authority.call.callId,
        interventionInvocationAttempt: 3,
      },
    ]);
  });

  test("rejects an imprecise intervention continuation envelope", async () => {
    const authority = await createWarningLedger("request-invalid-envelope");
    const registry = createRoleExecutorRegistry([
      {
        roleId: "worker",
        execute: vi.fn(
          async () =>
            ({
              kind: "continue",
              continuation: {
                kind: "operation_supervision_intervention",
                commit: {},
                unrelated: true,
              },
            }) as unknown as RoleExecutorActivationResult,
        ),
      },
    ]);

    await expect(
      registry.execute({
        requestId: "request-invalid-envelope",
        context: {},
        call: authority.call,
        ledger: authority.ledger,
      }),
    ).rejects.toThrow(
      "role_executor_result_invalid:worker:continuation_shape_invalid",
    );
    expect(authority.ledger.current()).toBe(authority.head);
  });

  test.each([
    {
      name: "a changed request",
      issueCode: "ledger_progress_invalid",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterState(fixture, { requestId: "different-request" }),
    },
    {
      name: "a changed policy",
      issueCode: "policy_changed",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterHead(
          fixture,
          Object.freeze({
            ...fixture.after,
            policy: Object.freeze({ ...fixture.after.policy }),
          }) as RoleCallLedgerHead,
        ),
    },
    {
      name: "a mismatched canonical effect",
      issueCode: "continuation_effect_mismatch",
      mutate: (fixture: ContinuationFixture) => ({
        ...fixture,
        commit: Object.freeze({
          ...fixture.commit,
          effect: Object.freeze({
            ...fixture.commit.effect,
            callId: "call-other",
          }),
        }) as RoleCallOperationSupervisionInterventionCommit,
      }),
    },
    {
      name: "an added call",
      issueCode: "call_set_changed",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterState(fixture, {
          calls: Object.freeze([
            ...fixture.after.state.calls,
            fixture.after.state.calls[0]!,
          ]),
        }),
    },
    {
      name: "an unrelated call mutation",
      issueCode: "unrelated_call_changed",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterState(fixture, {
          calls: Object.freeze(
            fixture.after.state.calls.map((call) =>
              call.callId === "call-1"
                ? Object.freeze({ ...call, activationCount: 2 })
                : call,
            ),
          ),
        }),
    },
    {
      name: "a fabricated execution collection",
      issueCode: "ledger_progress_invalid",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterState(fixture, {
          capabilityExecutions: Object.freeze([
            ...fixture.after.state.capabilityExecutions,
          ]),
        }),
    },
    {
      name: "a supervision state that does not match the effect",
      issueCode: "operation_supervision_state_invalid",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterState(fixture, {
          operationSupervision: Object.freeze({
            ...fixture.after.state.operationSupervision,
            entries: Object.freeze(
              fixture.after.state.operationSupervision.entries.map((entry) =>
                Object.freeze({
                  ...entry,
                  actionFingerprint: `sha256:${"b".repeat(64)}`,
                }),
              ),
            ),
          }),
        }),
    },
    {
      name: "a supervision capability that does not match the effect",
      issueCode: "operation_supervision_state_invalid",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterState(fixture, {
          operationSupervision: Object.freeze({
            ...fixture.after.state.operationSupervision,
            entries: Object.freeze(
              fixture.after.state.operationSupervision.entries.map((entry) =>
                Object.freeze({
                  ...entry,
                  capabilityId: "example.other_mutation",
                }),
              ),
            ),
          }),
        }),
    },
    {
      name: "a removed intervention record",
      issueCode: "operation_supervision_state_invalid",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterState(fixture, {
          operationSupervision: Object.freeze({
            ...fixture.after.state.operationSupervision,
            interventions: Object.freeze([]),
          }),
        }),
    },
    {
      name: "a mismatched intervention record",
      issueCode: "operation_supervision_state_invalid",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterState(fixture, {
          operationSupervision: Object.freeze({
            ...fixture.after.state.operationSupervision,
            interventions: Object.freeze(
              fixture.after.state.operationSupervision.interventions.map(
                (intervention) =>
                  Object.freeze({
                    ...intervention,
                    originExecutionId: "capability-execution-forged",
                  }),
              ),
            ),
          }),
        }),
    },
    {
      name: "a duplicate intervention record",
      issueCode: "operation_supervision_state_invalid",
      mutate: (fixture: ContinuationFixture) =>
        replaceAfterState(fixture, {
          operationSupervision: Object.freeze({
            ...fixture.after.state.operationSupervision,
            interventions: Object.freeze([
              ...fixture.after.state.operationSupervision.interventions,
              ...fixture.after.state.operationSupervision.interventions,
            ]),
          }),
        }),
    },
  ])("rejects $name", async ({ issueCode, mutate }) => {
    const fixture = mutate(
      await createContinuationFixture(`request-invalid-${issueCode}`),
    );
    const result =
      validateOperationSupervisionInterventionContinuation(fixture);
    expect(result).toEqual({ ok: false, issueCode });
  });
});

type ContinuationFixture = Readonly<{
  before: RoleCallLedgerHead;
  after: RoleCallLedgerHead;
  currentCall: RoleCallFrame;
  commit: RoleCallOperationSupervisionInterventionCommit;
}>;

async function createContinuationFixture(
  requestId: string,
): Promise<ContinuationFixture> {
  const authority = await createWarningLedger(requestId);
  const commit = await intervene(authority.ledger, authority.call);
  return Object.freeze({
    before: authority.head,
    after: commit.head,
    currentCall: authority.call,
    commit,
  });
}

function replaceAfterState(
  fixture: ContinuationFixture,
  replacement: Partial<RoleCallLedgerHead["state"]>,
): ContinuationFixture {
  const after = Object.freeze({
    ...fixture.after,
    state: Object.freeze({ ...fixture.after.state, ...replacement }),
  }) as RoleCallLedgerHead;
  return replaceAfterHead(fixture, after);
}

function replaceAfterHead(
  fixture: ContinuationFixture,
  after: RoleCallLedgerHead,
): ContinuationFixture {
  return Object.freeze({
    ...fixture,
    after,
    commit: Object.freeze({ ...fixture.commit, head: after }),
  });
}

async function createWarningLedger(requestId: string): Promise<
  Readonly<{
    ledger: RoleCallLedger;
    call: RoleCallFrame;
    head: RoleCallLedgerHead;
  }>
> {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  await commit(ledger, { authority: "runtime", type: "create_root" });
  await commit(ledger, {
    authority: "active_role",
    type: "open_child",
    callerCallId: "call-1",
    roleId: "worker",
    objective: "Mutate one bounded target.",
  });
  await settleFailedMutation(ledger);
  await settleFailedMutation(ledger);
  const head = ledger.current();
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (!call) throw new Error("active Worker call missing");
  expect(head.state.operationSupervision.entries).toEqual([
    {
      stage: "warning",
      capabilityId: "example.mutate",
      actionFingerprint: FINGERPRINT,
      priorOutcome: "failed",
      outcomeFingerprint: FAILURE_FINGERPRINT,
      originExecutionId: "capability-execution-2",
      matchingOutcomeCount: 2,
    },
  ]);
  expect(head.state.operationSupervision.interventions).toEqual([]);
  return Object.freeze({ ledger, call, head });
}

async function settleFailedMutation(ledger: RoleCallLedger): Promise<void> {
  const call = ledger
    .current()
    .state.calls.find(
      (candidate) => candidate.callId === ledger.current().state.activeCallId,
    );
  if (!call) throw new Error("active Worker call missing");
  const begun = await ledger.apply({
    expectedHead: ledger.current(),
    command: createBeginCommand(call),
  });
  if (!begun.ok || begun.effect.type !== "capability_execution_begun") {
    throw new Error("capability begin failed");
  }
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: call.callId,
    executionId: begun.effect.executionId,
    outcome: "failed",
    outcomeFingerprint: FAILURE_FINGERPRINT,
    observedEffect: "none",
    summary: "Mutation failed.",
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: false,
      payload: { summary: "Mutation failed." },
    },
  });
}

async function intervene(
  ledger: RoleCallLedger,
  call: RoleCallFrame,
): Promise<RoleCallOperationSupervisionInterventionCommit> {
  return requireRoleCallOperationSupervisionInterventionCommit(
    await ledger.apply({
      expectedHead: ledger.current(),
      command: createBeginCommand(call),
    }),
  );
}

function createBeginCommand(call: RoleCallFrame) {
  return {
    authority: "active_role" as const,
    type: "begin_capability_execution" as const,
    callId: call.callId,
    invocationAttempt: call.activationCount,
    capabilityId: "example.mutate",
    declaredEffect: "mutation" as const,
    intent: "Mutate one bounded target.",
    controlsJson: "{}",
    actionFingerprint: FINGERPRINT,
  };
}

async function commit(
  ledger: RoleCallLedger,
  command: RoleCallLedgerCommand,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(`commit rejected: ${result.code}`);
  return result.head;
}
