import {
  isRoleApprovalWait,
  validateRoleApprovalWait,
  type RoleApprovalWait,
} from "../approval-continuation.js";
import { createEnteredChildInvocation } from "../child-invocation/entered-child.js";
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
  RoleExecutionInput,
  RoleChildInvocationInput,
  RoleChildInvocationResult,
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
import { executeRoleWithModelOutputFailure } from "./model-output-failure.js";
import { normalizeRoleExecutorActivationResult } from "./result-normalization.js";
import { resolveCurrentCall } from "./state-validation.js";

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
      input: RoleExecutionInput<TContext>;
      registeredRoleIds: RoleExecutorRegistry<TContext, TValue>["roleIds"];
      executorByRoleId: ReadonlyMap<
        RoleExecutor<TContext, TValue>["roleId"],
        RoleExecutor<TContext, TValue>
      >;
      invokeChild(
        input: RoleChildInvocationInput<TContext>,
      ): Promise<RoleChildInvocationResult<TValue> | RoleApprovalWait>;
    }>,
  ) {
    this.expectedCall = params.input.call;
    this.continuationReference = params.input.continuationState?.capability;
  }

  async run(): Promise<RoleExecutionResult<TValue> | RoleApprovalWait> {
    const continued = await this.continueEnteredChild();
    if (continued) return continued;
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

  private async continueEnteredChild(): Promise<RoleApprovalWait | undefined> {
    const continuation = this.params.input.continuationState;
    if (!continuation?.callers.length) return undefined;
    const previousCall = continuation.callers[0]!.callerCall;
    if (previousCall.callId !== this.expectedCall.callId)
      throw stateError("approval_caller_cursor_mismatch");
    const child = await this.params.invokeChild(
      createEnteredChildInvocation({
        requestId: this.params.input.requestId,
        context: this.params.input.context,
        ledger: this.params.input.ledger,
        continuation,
      }),
    );
    if (isRoleApprovalWait(child)) return child;
    this.expectedCall = requireResumedCallerCall(
      child.returnCommit,
      previousCall,
    );
    this.continuationReference = Object.freeze({
      kind: "role_child",
      commit: child.returnCommit,
    });
    return undefined;
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
      expectedCall: this.expectedCall,
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
  ): Promise<RoleExecutionResult<TValue> | RoleApprovalWait | undefined> {
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
        await executeRoleWithModelOutputFailure(
          executor,
          {
            context: input.context,
            call: activation.call,
            ledger: input.ledger,
            availableChildRoleIds,
            ...(this.continuationReference
              ? { continuation: this.continuationReference }
              : {}),
          },
          activation.before.policy.limits.maxResultChars,
          input.requestId,
        ),
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

      if (isRoleApprovalWait(result.value)) {
        validateRoleApprovalWait(input.ledger, activation.call, result.value);
        return result.value;
      }
      if (result.value.kind === "terminal") {
        return this.completeTerminal(activation, result.value, turnCount);
      }
      if (result.value.kind === "invoke_role") {
        return this.continueThroughChild(activation, result.value, turnCount);
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
  ): Promise<RoleApprovalWait | undefined> {
    const { input } = this.params;
    const child = await this.params.invokeChild({
      allowApprovalWait: input.allowApprovalWait,
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
    if (isRoleApprovalWait(child)) return child;
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
