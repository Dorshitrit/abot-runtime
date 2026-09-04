import type {
  BeginRoleCapabilityBatchTransactionInput,
  BeginRoleCapabilityExecutionTransactionInput,
  OpenChildRoleCallCommand,
  RoleCallCommitEffect,
  RoleCallLedger,
  RoleCallLedgerCommit,
  RoleCallLedgerCommitResult,
  RoleCallTransactionInput,
  RoleCallTransactionResult,
  RoleCallTransactions,
  SettleRoleCapabilityExecutionCommand,
} from "./contracts.js";

type RoleCallLedgerApply = RoleCallLedger["apply"];

export function createRoleCallTransactions(
  apply: RoleCallLedgerApply,
): RoleCallTransactions {
  return Object.freeze({
    async createRoot(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "runtime",
            type: "create_root",
          },
        }),
        "root_created",
        "root_create_transition_invalid",
        () => true,
      );
    },

    async completeRootResponse(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "supervisor",
            type: "complete_root_response",
            callId: input.callId,
            response: input.response,
          },
        }),
        "root_response_committed",
        "root_response_transition_invalid",
        (effect) => effect.callId === input.callId,
      );
    },

    async openChild(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: createOpenChildCommand(input),
        }),
        "child_opened",
        "child_open_transition_invalid",
        (effect) => effect.callerCallId === input.callerCallId,
      );
    },

    async returnChild(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "runtime",
            type: "return_child",
            callerCallId: input.callerCallId,
            childCallId: input.childCallId,
            outcome: input.outcome,
            summary: input.summary,
            ...(input.receipt ? { receipt: input.receipt } : {}),
          },
        }),
        "child_returned",
        "child_return_transition_invalid",
        (effect) =>
          effect.callerCallId === input.callerCallId &&
          effect.childCallId === input.childCallId,
      );
    },

    async beginCapabilityExecution(input) {
      return requireCapabilityExecutionAttemptEffect(
        await apply({
          expectedHead: input.expectedHead,
          ...(input.admission
            ? { capabilityExecutionAdmission: input.admission }
            : {}),
          command: {
            authority: "active_role",
            type: "begin_capability_execution",
            callId: input.callId,
            invocationAttempt: input.invocationAttempt,
            capabilityId: input.capabilityId,
            declaredEffect: input.declaredEffect,
            intent: input.intent,
            controlsJson: input.controlsJson,
            ...(input.actionFingerprint
              ? { actionFingerprint: input.actionFingerprint }
              : {}),
          },
        }),
        input,
      );
    },

    async settleCapabilityExecution(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: createSettleCapabilityExecutionCommand(input),
        }),
        "capability_execution_settled",
        "commit_effect_invalid",
        (effect) =>
          effect.callId === input.callId &&
          effect.executionId === input.executionId,
      );
    },

    async beginCapabilityBatch(input) {
      return requireCapabilityBatchAttemptEffect(
        await apply({
          expectedHead: input.expectedHead,
          ...(input.admission
            ? { capabilityExecutionAdmission: input.admission }
            : {}),
          command: {
            authority: "active_role",
            type: "begin_capability_batch",
            callId: input.callId,
            invocationAttempt: input.invocationAttempt,
            entries: input.entries,
          },
        }),
        input,
      );
    },

    async settleCapabilityBatch(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "runtime",
            type: "settle_capability_batch",
            callId: input.callId,
            settlements: input.settlements,
          },
        }),
        "capability_batch_settled",
        "commit_effect_invalid",
        (effect) =>
          effect.callId === input.callId &&
          sameStrings(
            effect.executionIds,
            input.settlements.map(({ executionId }) => executionId),
          ),
      );
    },

    async updateCapabilityScope(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "active_role",
            type: "update_capability_scope",
            callId: input.callId,
            invocationAttempt: input.invocationAttempt,
            mode: input.mode,
            catalogGroupIds: input.catalogGroupIds,
          },
        }),
        "capability_scope_updated",
        "capability_scope_transition_invalid",
        (effect) => effect.callId === input.callId,
      );
    },

    async establishWorkingDirectory(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "active_role",
            type: "establish_working_directory",
            callId: input.callId,
            invocationAttempt: input.invocationAttempt,
            workingDirectory: input.workingDirectory,
          },
        }),
        "working_directory_established",
        "working_directory_transition_invalid",
        (effect) => effect.callId === input.callId,
      );
    },

    async reconsiderCapabilitySelection(input) {
      return requireEffect(
        await apply({
          expectedHead: input.expectedHead,
          command: {
            authority: "active_role",
            type: "reconsider_capability_selection",
            callId: input.callId,
            invocationAttempt: input.invocationAttempt,
            steeringVersion: input.steeringVersion,
            selection: input.selection,
            cause: input.cause,
          },
        }),
        "capability_selection_reconsidered",
        "capability_selection_reconsideration_transition_invalid",
        (effect) =>
          effect.callId === input.callId &&
          effect.invocationAttempt === input.invocationAttempt,
      );
    },
  });
}

function requireCapabilityExecutionAttemptEffect(
  commit: RoleCallLedgerCommitResult,
  input: BeginRoleCapabilityExecutionTransactionInput,
): RoleCallTransactionResult<
  "capability_execution_begun" | "operation_supervision_intervened",
  "commit_effect_invalid"
> {
  if (!commit.ok) {
    return Object.freeze({
      ok: false,
      issueCode: commit.code,
      commit,
    });
  }
  const effect = commit.effect;
  const isExpectedExecution =
    effect.type === "capability_execution_begun" &&
    effect.callId === input.callId;
  const isExpectedIntervention =
    effect.type === "operation_supervision_intervened" &&
    effect.callId === input.callId &&
    effect.invocationAttempt === input.invocationAttempt &&
    effect.capabilityId === input.capabilityId &&
    effect.actionFingerprint === input.actionFingerprint;
  if (!isExpectedExecution && !isExpectedIntervention) {
    return invalidEffect(commit, "commit_effect_invalid");
  }
  const typedCommit = commit as RoleCallLedgerCommit &
    Readonly<{
      effect: Extract<
        RoleCallCommitEffect,
        {
          type:
            | "capability_execution_begun"
            | "operation_supervision_intervened";
        }
      >;
    }>;
  return Object.freeze({ ok: true, commit: typedCommit });
}

function requireCapabilityBatchAttemptEffect(
  commit: RoleCallLedgerCommitResult,
  input: BeginRoleCapabilityBatchTransactionInput,
): RoleCallTransactionResult<
  "capability_batch_begun" | "operation_supervision_intervened",
  "commit_effect_invalid"
> {
  if (!commit.ok) {
    return Object.freeze({
      ok: false,
      issueCode: commit.code,
      commit,
    });
  }
  const effect = commit.effect;
  const isExpectedBatch =
    effect.type === "capability_batch_begun" &&
    effect.callId === input.callId &&
    effect.executionIds.length === input.entries.length;
  const isExpectedIntervention =
    effect.type === "operation_supervision_intervened" &&
    effect.callId === input.callId &&
    effect.invocationAttempt === input.invocationAttempt &&
    input.entries.some(
      (entry) =>
        entry.capabilityId === effect.capabilityId &&
        entry.actionFingerprint === effect.actionFingerprint,
    );
  if (!isExpectedBatch && !isExpectedIntervention) {
    return invalidEffect(commit, "commit_effect_invalid");
  }
  const typedCommit = commit as RoleCallLedgerCommit &
    Readonly<{
      effect: Extract<
        RoleCallCommitEffect,
        {
          type: "capability_batch_begun" | "operation_supervision_intervened";
        }
      >;
    }>;
  return Object.freeze({ ok: true, commit: typedCommit });
}

export function resolveRoleCallTransactions(
  ledger: RoleCallLedger,
): RoleCallTransactions {
  if (ledger.transactions) {
    return ledger.transactions;
  }
  return createRoleCallTransactions((input) => ledger.apply(input));
}

function createOpenChildCommand(
  input: RoleCallTransactionInput<OpenChildRoleCallCommand>,
): OpenChildRoleCallCommand {
  return {
    authority: "active_role",
    type: "open_child",
    callerCallId: input.callerCallId,
    roleId: input.roleId,
    objective: input.objective,
    dependencyResultRefs: input.dependencyResultRefs,
    ...(input.workerCapabilityScope
      ? { workerCapabilityScope: input.workerCapabilityScope }
      : {}),
    ...(input.workingDirectory !== undefined
      ? { workingDirectory: input.workingDirectory }
      : {}),
    ...(input.plannerPlan ? { plannerPlan: input.plannerPlan } : {}),
  };
}

function createSettleCapabilityExecutionCommand(
  input: RoleCallTransactionInput<SettleRoleCapabilityExecutionCommand>,
): SettleRoleCapabilityExecutionCommand {
  return {
    authority: "runtime",
    type: "settle_capability_execution",
    callId: input.callId,
    executionId: input.executionId,
    outcome: input.outcome,
    ...(input.outcomeFingerprint
      ? { outcomeFingerprint: input.outcomeFingerprint }
      : {}),
    observedEffect: input.observedEffect,
    summary: input.summary,
    exactResult: input.exactResult,
    ...(input.referenceData ? { referenceData: input.referenceData } : {}),
    ...(input.references ? { references: input.references } : {}),
  };
}

function requireEffect<
  TEffectType extends RoleCallCommitEffect["type"],
  TTransitionIssueCode extends string,
>(
  commit: RoleCallLedgerCommitResult,
  effectType: TEffectType,
  invalidEffectIssueCode: TTransitionIssueCode,
  validate: (
    effect: Extract<RoleCallCommitEffect, { type: TEffectType }>,
  ) => boolean,
): RoleCallTransactionResult<TEffectType, TTransitionIssueCode> {
  if (!commit.ok) {
    return Object.freeze({
      ok: false,
      issueCode: commit.code,
      commit,
    });
  }
  if (commit.effect.type !== effectType) {
    return invalidEffect(commit, invalidEffectIssueCode);
  }
  const typedCommit = commit as RoleCallLedgerCommit &
    Readonly<{
      effect: Extract<RoleCallCommitEffect, { type: TEffectType }>;
    }>;
  if (!validate(typedCommit.effect)) {
    return invalidEffect(commit, invalidEffectIssueCode);
  }
  return Object.freeze({ ok: true, commit: typedCommit });
}

function invalidEffect<TTransitionIssueCode extends string>(
  commit: RoleCallLedgerCommit,
  issueCode: TTransitionIssueCode,
): RoleCallTransactionResult<never, TTransitionIssueCode> {
  return Object.freeze({
    ok: false,
    issueCode,
    commit,
  });
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
