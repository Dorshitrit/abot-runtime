import { consumeUnexpectedThenable } from "../synchronous-boundary.js";
import { createCanonicalStateHeadFactory } from "../state-head.js";
import {
  ROLE_CALL_LEDGER_HEAD_KIND,
  type RoleCallCommitEffect,
  type RoleCallLedger,
  type RoleCallLedgerCommit,
  type RoleCallLedgerCommitObserver,
  type RoleCallLedgerCommitResult,
  type RoleCallLedgerHead,
  type RoleCallLedgerRejectionCode,
  type RoleCallPolicy,
  type RoleCallPolicyInput,
  type RoleCallState,
  type RoleCallTransitionRejectionCode,
  type RoleCallValidationIssue,
} from "./contracts.js";
import {
  traceRoleCallCommit,
  traceRoleCallCommitFault,
  traceRoleCallRejection,
  type RoleCallRejectedCommandDiagnostic,
} from "./diagnostics.js";
import {
  applyRoleCallCommand,
  createInitialRoleCallState,
  sealRoleCallPolicy,
  validateRoleCallCandidate,
} from "./reducer.js";
import { createRoleCallTransactions } from "./transactions.js";
import { ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH } from "./working-directory.js";

const createRoleCallStateHead = createCanonicalStateHeadFactory<
  typeof ROLE_CALL_LEDGER_HEAD_KIND,
  RoleCallState,
  RoleCallPolicy,
  RoleCallValidationIssue
>({
  compatibilityHeadKind: ROLE_CALL_LEDGER_HEAD_KIND,
  validationLabel: "role-call ledger head",
  validateCandidate: validateRoleCallCandidate,
});

export function createRoleCallLedger(params: {
  requestId: string;
  policy: RoleCallPolicyInput;
}): RoleCallLedger {
  const channel = createRoleCallStateHead({
    state: createInitialRoleCallState(params.requestId),
    policy: sealRoleCallPolicy(params.policy),
  });
  const commitObservers = new Set<RoleCallLedgerCommitObserver>();
  const commits = Object.freeze({
    subscribe(observer: RoleCallLedgerCommitObserver) {
      if (typeof observer !== "function") {
        throw new TypeError(
          "A synchronous role-call commit observer is required.",
        );
      }
      commitObservers.add(observer);
    },
  });

  const apply: RoleCallLedger["apply"] = async (input) => {
    let attemptedCommitEffect: RoleCallCommitEffect | undefined;
    const commandType = classifyCommandType(input.command);
    const capturedCommand = captureCommand(input.command);
    const commandDiagnostic = projectRejectedCommand(capturedCommand);
    const result = await channel.writer.transaction<
      | Readonly<{
          kind: "transition_rejected";
          code: RoleCallTransitionRejectionCode;
          issues?: readonly RoleCallValidationIssue[];
        }>
      | Readonly<{
          kind: "committed";
          effect: RoleCallCommitEffect;
        }>
    >({
      expectedHead: input.expectedHead,
      run(transaction) {
        const transition = applyRoleCallCommand(
          transaction.head.state,
          capturedCommand,
          transaction.head.policy,
        );
        if (!transition.ok) {
          return {
            kind: "transition_rejected",
            code: transition.code,
            ...(transition.issues ? { issues: transition.issues } : {}),
          };
        }
        attemptedCommitEffect = transition.effect;
        const commit = transaction.commit(
          {
            state: transition.state,
            policy: transaction.head.policy,
          },
          ({ previousHead, head }) => {
            notifyCommitObservers(commitObservers, {
              ok: true,
              status: "committed",
              previousHead,
              head,
              effect: transition.effect,
            });
          },
        );
        if (!commit.ok) {
          throw new Error(`role_call_head_commit_failed:${commit.code}`);
        }
        return { kind: "committed", effect: transition.effect };
      },
    });

    if (!result.ok) {
      if (result.status === "committed_with_fault" && attemptedCommitEffect) {
        const faulted: RoleCallLedgerCommitResult = Object.freeze({
          ok: false,
          status: "committed_with_fault",
          code: result.code,
          previousHead: result.previousHead,
          head: result.head,
          effect: attemptedCommitEffect,
        });
        traceRoleCallCommitFault({
          previousHead: result.previousHead,
          head: result.head,
          effect: attemptedCommitEffect,
          code: result.code,
        });
        return faulted;
      }
      const code: RoleCallLedgerRejectionCode =
        result.code === "invalid_expected_head" || result.code === "stale_head"
          ? result.code
          : "state_head_rejected";
      return rejectedResult(result.head, commandType, code, commandDiagnostic);
    }
    if (result.status === "unchanged") {
      const value = result.value;
      if (value.kind !== "transition_rejected") {
        return rejectedResult(
          result.head,
          commandType,
          "state_head_rejected",
          commandDiagnostic,
        );
      }
      return rejectedResult(
        result.head,
        commandType,
        value.code,
        commandDiagnostic,
        value.issues,
      );
    }
    if (result.value.kind !== "committed") {
      return rejectedResult(
        result.head,
        commandType,
        "state_head_rejected",
        commandDiagnostic,
      );
    }
    const committed: RoleCallLedgerCommitResult = Object.freeze({
      ok: true,
      status: "committed",
      previousHead: result.previousHead,
      head: result.head,
      effect: result.value.effect,
    });
    traceRoleCallCommit({
      previousHead: result.previousHead,
      head: result.head,
      effect: result.value.effect,
    });
    return committed;
  };
  const transactions = createRoleCallTransactions(apply);

  return Object.freeze({
    current() {
      return channel.reader.current();
    },
    commits,
    transactions,
    apply,
  });
}

function notifyCommitObservers(
  observers: ReadonlySet<RoleCallLedgerCommitObserver>,
  commit: RoleCallLedgerCommit,
): void {
  let failed = false;
  const frozenCommit = Object.freeze(commit);
  for (const observer of [...observers]) {
    try {
      const result = Reflect.apply(observer, undefined, [frozenCommit]);
      if (consumeUnexpectedThenable(result)) {
        failed = true;
      }
    } catch {
      failed = true;
    }
  }
  if (failed) {
    throw new TypeError("One or more role-call commit observers failed.");
  }
}

function rejectedResult(
  head: RoleCallLedgerHead,
  commandType: string,
  code: RoleCallLedgerRejectionCode,
  command: RoleCallRejectedCommandDiagnostic,
  issues?: readonly RoleCallValidationIssue[],
): RoleCallLedgerCommitResult {
  traceRoleCallRejection({
    head,
    commandType,
    code,
    command,
    ...(issues ? { issues } : {}),
  });
  return Object.freeze({
    ok: false,
    status: "rejected",
    code,
    head,
    ...(issues ? { issues: Object.freeze([...issues]) } : {}),
  });
}

function captureCommand(input: unknown): unknown {
  try {
    return structuredClone(input);
  } catch {
    return undefined;
  }
}

function classifyCommandType(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as { type?: unknown }).type === "string"
  ) {
    return (input as { type: string }).type.slice(0, 64);
  }
  return "invalid";
}

function projectRejectedCommand(
  input: unknown,
): RoleCallRejectedCommandDiagnostic {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    typeof (input as { type?: unknown }).type !== "string"
  ) {
    return Object.freeze({});
  }
  const command = input as Record<string, unknown>;
  if (command.type === "open_child") {
    const plannerPlan =
      typeof command.plannerPlan === "object" &&
      command.plannerPlan !== null &&
      !Array.isArray(command.plannerPlan)
        ? (command.plannerPlan as Record<string, unknown>)
        : undefined;
    const declaredPlan =
      typeof plannerPlan?.plan === "object" &&
      plannerPlan.plan !== null &&
      !Array.isArray(plannerPlan.plan)
        ? (plannerPlan.plan as Record<string, unknown>)
        : undefined;
    const planExtension =
      typeof plannerPlan?.extension === "object" &&
      plannerPlan.extension !== null &&
      !Array.isArray(plannerPlan.extension)
        ? (plannerPlan.extension as Record<string, unknown>)
        : undefined;
    const workerCapabilityScope =
      typeof command.workerCapabilityScope === "object" &&
      command.workerCapabilityScope !== null &&
      !Array.isArray(command.workerCapabilityScope)
        ? (command.workerCapabilityScope as Record<string, unknown>)
        : undefined;
    return Object.freeze({
      ...(safeIdentifier(command.callerCallId)
        ? { attemptedCallId: command.callerCallId }
        : {}),
      ...(Array.isArray(command.dependencyResultRefs)
        ? {
            attemptedDependencyResultRefs: Object.freeze(
              command.dependencyResultRefs.filter(safeIdentifier).slice(0, 64),
            ),
          }
        : {}),
      ...(Array.isArray(workerCapabilityScope?.catalogGroupIds)
        ? {
            attemptedWorkerCapabilityCatalogGroupIds: Object.freeze(
              workerCapabilityScope.catalogGroupIds
                .filter(safeIdentifier)
                .slice(0, 64),
            ),
          }
        : {}),
      ...(command.workingDirectory !== undefined
        ? {
            attemptedWorkingDirectoryIncluded: true,
            ...(typeof command.workingDirectory === "string"
              ? {
                  attemptedWorkingDirectoryLength: Math.min(
                    command.workingDirectory.length,
                    ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH + 1,
                  ),
                }
              : {}),
          }
        : {}),
      ...(plannerPlan?.mode === "declare" ||
      plannerPlan?.mode === "select" ||
      plannerPlan?.mode === "extend"
        ? { attemptedPlanMode: plannerPlan.mode }
        : {}),
      ...(Array.isArray(plannerPlan?.itemIds)
        ? {
            attemptedPlanItemIds: Object.freeze(
              plannerPlan.itemIds.filter(safeIdentifier).slice(0, 64),
            ),
          }
        : {}),
      ...(Array.isArray(declaredPlan?.items)
        ? { attemptedPlanItemCount: declaredPlan.items.length }
        : Array.isArray(planExtension?.items)
          ? { attemptedPlanItemCount: planExtension.items.length }
          : {}),
      ...(typeof declaredPlan?.summary === "string"
        ? { attemptedPlanSummaryLength: declaredPlan.summary.length }
        : {}),
      ...(plannerPlan && Array.isArray(plannerPlan.selectedItemIndexes)
        ? {
            attemptedSelectedItemIndexes: Object.freeze(
              plannerPlan.selectedItemIndexes
                .filter((value) => Number.isSafeInteger(value))
                .slice(0, 64) as number[],
            ),
          }
        : {}),
    });
  }
  if (command.type === "begin_capability_execution") {
    return Object.freeze({
      ...(safeIdentifier(command.callId)
        ? { attemptedCallId: command.callId }
        : {}),
      ...(Number.isInteger(command.invocationAttempt)
        ? { attemptedInvocationAttempt: command.invocationAttempt as number }
        : {}),
      ...(safeIdentifier(command.capabilityId)
        ? { attemptedCapabilityId: command.capabilityId }
        : {}),
      ...(isCapabilityEffect(command.declaredEffect)
        ? { attemptedDeclaredEffect: command.declaredEffect }
        : {}),
    });
  }
  if (command.type === "update_capability_scope") {
    return Object.freeze({
      ...(safeIdentifier(command.callId)
        ? { attemptedCallId: command.callId }
        : {}),
      ...(Number.isInteger(command.invocationAttempt)
        ? { attemptedInvocationAttempt: command.invocationAttempt as number }
        : {}),
      ...(command.mode === "open" || command.mode === "extend"
        ? { attemptedCapabilityScopeMode: command.mode }
        : {}),
      ...(Array.isArray(command.catalogGroupIds)
        ? {
            attemptedWorkerCapabilityCatalogGroupIds: Object.freeze(
              command.catalogGroupIds.filter(safeIdentifier).slice(0, 64),
            ),
          }
        : {}),
    });
  }
  if (command.type === "establish_working_directory") {
    return Object.freeze({
      ...(safeIdentifier(command.callId)
        ? { attemptedCallId: command.callId }
        : {}),
      ...(Number.isInteger(command.invocationAttempt)
        ? { attemptedInvocationAttempt: command.invocationAttempt as number }
        : {}),
      attemptedWorkingDirectoryIncluded: true,
      ...(typeof command.workingDirectory === "string"
        ? {
            attemptedWorkingDirectoryLength: Math.min(
              command.workingDirectory.length,
              ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH + 1,
            ),
          }
        : {}),
    });
  }
  if (command.type === "settle_capability_execution") {
    return Object.freeze({
      ...(safeIdentifier(command.callId)
        ? { attemptedCallId: command.callId }
        : {}),
      ...(safeIdentifier(command.executionId)
        ? { attemptedExecutionId: command.executionId }
        : {}),
      ...(command.outcome === "succeeded" || command.outcome === "failed"
        ? { attemptedOutcome: command.outcome }
        : {}),
      ...(isCapabilityObservedEffect(command.observedEffect)
        ? { attemptedObservedEffect: command.observedEffect }
        : {}),
    });
  }
  return Object.freeze({});
}

function safeIdentifier(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= 128 &&
    /^[a-zA-Z0-9._-]+$/.test(input)
  );
}

function isCapabilityEffect(
  input: unknown,
): input is "observation" | "mutation" | "mixed" {
  return input === "observation" || input === "mutation" || input === "mixed";
}

function isCapabilityObservedEffect(
  input: unknown,
): input is "none" | "observation" | "mutation" | "indeterminate" {
  return (
    input === "none" ||
    input === "observation" ||
    input === "mutation" ||
    input === "indeterminate"
  );
}
