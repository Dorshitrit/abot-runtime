import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../role-calls/index.js";
import { isRuntimeDelegateRoleId } from "../../roles.js";
import type {
  RoleExecutionContinuationReference,
  RoleExecutionResult,
  RoleExecutor,
  RoleExecutorActivationResult,
  RoleExecutorRegistry,
} from "../contracts.js";
import {
  traceRoleExecutorCompleted,
  traceRoleExecutorFailed,
  traceRoleExecutorInitialStateRejected,
  traceRoleExecutorResolved,
  traceRoleExecutorResultRejected,
  traceRoleExecutorStarted,
  traceRoleExecutorStateRejected,
  traceRoleExecutorUnavailable,
} from "../diagnostics.js";
import { requireResumedCallerCall } from "../child-invocation/state-validation.js";
import {
  createAttemptDiagnostic,
  createDiagnostic,
  type RoleExecutorDiagnosticContext,
} from "../shared/diagnostic-context.js";
import {
  readLedgerOrReject,
  stateError,
} from "../shared/runtime-invariants.js";
import { continueRoleThroughCapability } from "./capability-continuation.js";
import { normalizeRoleExecutorActivationResult } from "./result-normalization.js";
import { resolveCurrentCall } from "./state-validation.js";

type RoleExecutionInput<TContext, TValue> = Parameters<
  RoleExecutorRegistry<TContext, TValue>["execute"]
>[0];

type CurrentRoleActivation = Readonly<{
  before: RoleCallLedgerHead;
  call: RoleCallFrame;
  diagnostic: RoleExecutorDiagnosticContext;
}>;

export class RoleActivationLoop<TContext, TValue> {
  private expectedCall: RoleCallFrame;
  private continuationReference: RoleExecutionContinuationReference | undefined;

  constructor(
    private readonly params: Readonly<{
      input: RoleExecutionInput<TContext, TValue>;
      registeredRoleIds: RoleExecutorRegistry<TContext, TValue>["roleIds"];
      executorByRoleId: ReadonlyMap<
        RoleExecutor<TContext, TValue>["roleId"],
        RoleExecutor<TContext, TValue>
      >;
      invokeChild: RoleExecutorRegistry<TContext, TValue>["invokeChild"];
    }>,
  ) {
    this.expectedCall = params.input.call;
  }

  async run(): Promise<RoleExecutionResult<TValue>> {
    const { executor, call } = this.resolveInitialActivation();
    this.expectedCall = call;

    for (let turnCount = 1; ; turnCount += 1) {
      const activation = this.requireCurrentActivation(turnCount);
      const terminal = await this.runActivation(
        executor,
        activation,
        turnCount,
      );
      if (terminal) return terminal;
    }
  }

  private resolveInitialActivation(): Readonly<{
    executor: RoleExecutor<TContext, TValue>;
    call: RoleCallFrame;
  }> {
    const { input, registeredRoleIds, executorByRoleId } = this.params;
    const attemptedRoleId = isRuntimeDelegateRoleId(input.call.roleId)
      ? input.call.roleId
      : undefined;
    const initialAttemptDiagnostic = createAttemptDiagnostic({
      requestId: input.requestId,
      callId: input.call.callId,
      ...(attemptedRoleId ? { attemptedRoleId } : {}),
      registeredRoleIds,
    });
    if (!isRuntimeDelegateRoleId(input.call.roleId)) {
      traceRoleExecutorUnavailable(initialAttemptDiagnostic);
      throw new Error("role_executor_not_registered");
    }
    const executor = executorByRoleId.get(input.call.roleId);
    if (!executor) {
      traceRoleExecutorUnavailable(initialAttemptDiagnostic);
      throw new Error("role_executor_not_registered");
    }

    let initialHead: RoleCallLedgerHead;
    try {
      initialHead = input.ledger.current();
    } catch {
      traceRoleExecutorInitialStateRejected(
        initialAttemptDiagnostic,
        "ledger_read_failed",
      );
      throw stateError("ledger_read_failed");
    }
    const initialAuthority = resolveCurrentCall({
      head: initialHead,
      requestId: input.requestId,
      expectedCall: input.call,
    });
    if (!initialAuthority.ok) {
      traceRoleExecutorInitialStateRejected(
        initialAttemptDiagnostic,
        initialAuthority.issueCode,
      );
      throw stateError(initialAuthority.issueCode);
    }

    const initialDiagnostic = createDiagnostic({
      requestId: initialHead.state.requestId,
      call: initialAuthority.call,
      registeredRoleIds,
    });
    traceRoleExecutorResolved(initialDiagnostic);
    return Object.freeze({
      executor,
      call: initialAuthority.call,
    });
  }

  private requireCurrentActivation(turnCount: number): CurrentRoleActivation {
    const { input, registeredRoleIds } = this.params;
    let before: RoleCallLedgerHead;
    try {
      before = input.ledger.current();
    } catch {
      const diagnostic = createDiagnostic({
        requestId: input.requestId,
        call: this.expectedCall,
        registeredRoleIds,
      });
      traceRoleExecutorStateRejected(
        diagnostic,
        "ledger_read_failed",
        turnCount,
      );
      throw stateError("ledger_read_failed");
    }
    const authority = resolveCurrentCall({
      head: before,
      requestId: input.requestId,
      expectedCall: this.expectedCall,
    });
    const diagnostic = createDiagnostic({
      requestId: input.requestId,
      call: authority.ok ? authority.call : this.expectedCall,
      registeredRoleIds,
    });
    if (!authority.ok) {
      traceRoleExecutorStateRejected(
        diagnostic,
        authority.issueCode,
        turnCount,
      );
      throw stateError(authority.issueCode);
    }
    return Object.freeze({
      before,
      call: authority.call,
      diagnostic,
    });
  }

  private async runActivation(
    executor: RoleExecutor<TContext, TValue>,
    activation: CurrentRoleActivation,
    turnCount: number,
  ): Promise<RoleExecutionResult<TValue> | undefined> {
    const { input, registeredRoleIds } = this.params;
    const availableChildRoleIds = Object.freeze(
      registeredRoleIds.filter((roleId) => roleId !== activation.call.roleId),
    );
    traceRoleExecutorStarted(activation.diagnostic, {
      availableChildRoleIds,
      turnCount,
    });

    try {
      const result = normalizeRoleExecutorActivationResult(
        await executor.execute({
          context: input.context,
          call: activation.call,
          ledger: input.ledger,
          availableChildRoleIds,
          ...(this.continuationReference
            ? { continuation: this.continuationReference }
            : {}),
        }),
        activation.before.policy.limits.maxResultChars,
        activation.before.policy.limits.maxObjectiveChars,
      );
      if (!result.ok) {
        traceRoleExecutorResultRejected(
          activation.diagnostic,
          result.issueCode,
        );
        throw new Error(
          "role_executor_result_invalid:" +
            activation.call.roleId +
            ":" +
            result.issueCode,
        );
      }

      if (result.value.kind === "terminal") {
        return this.completeTerminal(activation, result.value, turnCount);
      }
      if (result.value.kind === "invoke_role") {
        await this.continueThroughChild(activation, result.value, turnCount);
        return undefined;
      }
      const continued = continueRoleThroughCapability({
        ledger: input.ledger,
        before: activation.before,
        currentCall: activation.call,
        diagnostic: activation.diagnostic,
        continuation: result.value.continuation,
        turnCount,
      });
      this.expectedCall = continued.call;
      this.continuationReference = continued.continuationReference;
      return undefined;
    } catch (error: unknown) {
      traceRoleExecutorFailed(activation.diagnostic, error);
      throw error;
    }
  }

  private completeTerminal(
    activation: CurrentRoleActivation,
    result: RoleExecutionResult<TValue>,
    turnCount: number,
  ): RoleExecutionResult<TValue> {
    const after = readLedgerOrReject({
      ledger: this.params.input.ledger,
      diagnostic: activation.diagnostic,
      turnCount,
    });
    if (!isTerminalStateFresh(after, activation.before)) {
      traceRoleExecutorResultRejected(
        activation.diagnostic,
        "terminal_state_changed",
      );
      throw new Error(
        "role_executor_result_invalid:" +
          activation.call.roleId +
          ":terminal_state_changed",
      );
    }
    traceRoleExecutorCompleted(activation.diagnostic, {
      outcome: result.outcome,
      summaryLength: result.summary.length,
      hasValue: result.value !== undefined,
      turnCount,
    });
    return result;
  }

  private async continueThroughChild(
    activation: CurrentRoleActivation,
    result: Extract<
      RoleExecutorActivationResult<TValue>,
      { kind: "invoke_role" }
    >,
    turnCount: number,
  ): Promise<void> {
    const { input } = this.params;
    const child = await this.params.invokeChild({
      requestId: input.requestId,
      context: input.context,
      callerCall: activation.call,
      ledger: input.ledger,
      expectedHead: activation.before,
      roleId: result.roleId,
      objective: result.objective,
      ...(result.workerCapabilityScope
        ? { workerCapabilityScope: result.workerCapabilityScope }
        : {}),
      ...(result.workingDirectory !== undefined
        ? { workingDirectory: result.workingDirectory }
        : {}),
      ...(result.plannerPlan ? { plannerPlan: result.plannerPlan } : {}),
      turnCount,
    });
    const continuationReference = Object.freeze({
      kind: "role_child" as const,
      commit: child.returnCommit,
    });
    this.expectedCall = requireResumedCallerCall(
      child.returnCommit,
      activation.call,
    );
    this.continuationReference = continuationReference;
  }
}

function isTerminalStateFresh(
  after: RoleCallLedgerHead,
  before: RoleCallLedgerHead,
): boolean {
  return after === before;
}
