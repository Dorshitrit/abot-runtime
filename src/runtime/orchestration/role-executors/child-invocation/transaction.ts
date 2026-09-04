import type {
  RoleCallChildReturnCommit,
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../role-calls/index.js";
import {
  projectRoleChildReturnContext,
  requireRoleCallChildReturnCommit,
  resolveRoleCallTransactions,
} from "../../role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../../roles.js";
import type {
  RoleChildInvocationResult,
  RoleExecutionResult,
  RoleExecutorRegistry,
} from "../contracts.js";
import {
  traceRoleExecutorChildCompleted,
  traceRoleExecutorChildContinued,
  traceRoleExecutorChildRejected,
  traceRoleExecutorChildRequested,
  traceRoleExecutorChildStarted,
} from "../diagnostics.js";
import {
  planBindingDiagnosticFields,
  workerCapabilityScopeDiagnosticFields,
  workingDirectoryDiagnosticFields,
} from "./diagnostic-fields.js";
import {
  isValidChildReturnTransition,
  isValidOpenedChildProjection,
  isValidResumeProjection,
  type OpenedChild,
  projectPriorDirectSiblingResultRefs,
  requireResumedCallerCall,
  resolveActiveCaller,
} from "./state-validation.js";
import {
  createDiagnostic,
  type RoleExecutorDiagnosticContext,
} from "../shared/diagnostic-context.js";
import {
  childInvocationError,
  readLedgerOrReject,
} from "../shared/runtime-invariants.js";

type RoleChildInvocationInput<TContext, TValue> = Parameters<
  RoleExecutorRegistry<TContext, TValue>["invokeChild"]
>[0];

export class ChildInvocationTransaction<TContext, TValue> {
  private readonly diagnostic: RoleExecutorDiagnosticContext;
  private readonly transactions: ReturnType<typeof resolveRoleCallTransactions>;

  constructor(
    private readonly params: Readonly<{
      input: RoleChildInvocationInput<TContext, TValue>;
      registeredRoleIds: RoleExecutorRegistry<TContext, TValue>["roleIds"];
      isRoleRegistered(
        roleId: RoleChildInvocationInput<TContext, TValue>["roleId"],
      ): boolean;
      executeRole: RoleExecutorRegistry<TContext, TValue>["execute"];
    }>,
  ) {
    this.transactions = resolveRoleCallTransactions(params.input.ledger);
    this.diagnostic = createDiagnostic({
      requestId: params.input.requestId,
      call: params.input.callerCall,
      registeredRoleIds: params.registeredRoleIds,
    });
  }

  async run(): Promise<RoleChildInvocationResult<TValue>> {
    const before = this.readExpectedCallerHead();
    const callerCall = this.requireActiveCaller(before);
    this.requireInvocableChildRole(callerCall);

    const dependencyResultRefs = projectPriorDirectSiblingResultRefs(
      before,
      callerCall,
    );
    this.traceChildRequested(callerCall, dependencyResultRefs);

    const openedChild = await this.openChild(
      before,
      callerCall,
      dependencyResultRefs,
    );
    const execution = await this.params.executeRole({
      requestId: this.params.input.requestId,
      context: this.params.input.context,
      call: openedChild.call,
      ledger: this.params.input.ledger,
    });
    traceRoleExecutorChildCompleted(this.diagnostic, {
      childCallId: openedChild.call.callId,
      childRoleId: openedChild.call.roleId,
      outcome: execution.outcome,
      summaryLength: execution.summary.length,
      turnCount: this.params.input.turnCount,
    });

    const returnCommit = await this.returnChild(
      openedChild,
      callerCall,
      execution,
    );
    return Object.freeze({
      execution,
      returnCommit,
    });
  }

  private readExpectedCallerHead(): RoleCallLedgerHead {
    const { input } = this.params;
    let before: RoleCallLedgerHead;
    try {
      before = input.ledger.current();
    } catch {
      this.rejectChild({
        issueCode: "ledger_read_failed",
        callerCall: input.callerCall,
      });
    }
    if (before !== input.expectedHead) {
      this.rejectChild({
        issueCode: "child_request_state_changed",
        callerCall: input.callerCall,
      });
    }
    return before;
  }

  private requireActiveCaller(before: RoleCallLedgerHead): RoleCallFrame {
    const { input } = this.params;
    const callerAuthority = resolveActiveCaller({
      head: before,
      requestId: input.requestId,
      expectedCall: input.callerCall,
    });
    if (!callerAuthority.ok) {
      this.rejectChild({
        issueCode: callerAuthority.issueCode,
        callerCall: input.callerCall,
      });
    }
    return callerAuthority.call;
  }

  private requireInvocableChildRole(callerCall: RoleCallFrame): void {
    const { input } = this.params;
    if (input.roleId === callerCall.roleId) {
      this.rejectChild({
        issueCode: "child_role_matches_caller",
        callerCall,
      });
    }
    if (!this.params.isRoleRegistered(input.roleId)) {
      this.rejectChild({
        issueCode: "child_executor_not_registered",
        callerCall,
      });
    }
  }

  private traceChildRequested(
    callerCall: RoleCallFrame,
    dependencyResultRefs: readonly string[],
  ): void {
    const { input } = this.params;
    traceRoleExecutorChildRequested(this.diagnostic, {
      childRoleId: input.roleId,
      childObjectiveLength: input.objective.length,
      dependencyResolution: "all_prior_direct_siblings_v1",
      inheritedSiblingResultCount: dependencyResultRefs.length,
      inheritedSiblingResultRefs: dependencyResultRefs,
      dependencyResultCount: dependencyResultRefs.length,
      dependencyResultRefs,
      ...workerCapabilityScopeDiagnosticFields(input.workerCapabilityScope),
      ...workingDirectoryDiagnosticFields(input.workingDirectory),
      ...planBindingDiagnosticFields(input.plannerPlan),
      fromActivation: callerCall.activationCount,
      turnCount: input.turnCount,
    });
  }

  private async openChild(
    before: RoleCallLedgerHead,
    callerCall: RoleCallFrame,
    dependencyResultRefs: readonly string[],
  ): Promise<OpenedChild> {
    const { input } = this.params;
    const openedResult = await this.transactions.openChild({
      expectedHead: before,
      callerCallId: callerCall.callId,
      roleId: input.roleId,
      objective: input.objective,
      dependencyResultRefs,
      ...(input.workerCapabilityScope
        ? { workerCapabilityScope: input.workerCapabilityScope }
        : {}),
      ...(input.workingDirectory !== undefined
        ? { workingDirectory: input.workingDirectory }
        : {}),
      ...(input.plannerPlan ? { plannerPlan: input.plannerPlan } : {}),
    });
    if (!openedResult.ok) {
      this.rejectChild({
        issueCode: openedResult.issueCode,
        callerCall,
      });
    }
    const opened = openedResult.commit;

    const openedChildCallId = opened.effect.childCallId;
    const childCall = opened.head.state.calls.find(
      (candidate) => candidate.callId === openedChildCallId,
    );
    if (
      !isValidOpenedChildProjection(
        input.ledger,
        opened,
        callerCall,
        input,
        dependencyResultRefs,
        childCall,
      )
    ) {
      this.rejectChild({
        issueCode: "child_open_projection_invalid",
        callerCall,
      });
    }

    traceRoleExecutorChildStarted(this.diagnostic, {
      childCallId: childCall.callId,
      childRoleId: childCall.roleId,
      childDepth: childCall.depth,
      dependencyResultCount: childCall.dependencyResultRefs.length,
      dependencyResultRefs: childCall.dependencyResultRefs,
      ...workerCapabilityScopeDiagnosticFields(childCall.workerCapabilityScope),
      ...workingDirectoryDiagnosticFields(childCall.workingDirectory),
      ...(opened.effect.planItemIds
        ? { planItemIds: opened.effect.planItemIds }
        : {}),
      turnCount: input.turnCount,
    });
    return Object.freeze({ commit: opened, call: childCall });
  }

  private async returnChild(
    openedChild: OpenedChild,
    callerCall: RoleCallFrame,
    execution: RoleExecutionResult<TValue>,
  ): Promise<RoleCallChildReturnCommit> {
    const { input } = this.params;
    const beforeReturn = readLedgerOrReject({
      ledger: input.ledger,
      diagnostic: this.diagnostic,
      turnCount: input.turnCount,
    });
    const returnedResult = await this.transactions.returnChild({
      expectedHead: beforeReturn,
      callerCallId: callerCall.callId,
      childCallId: openedChild.call.callId,
      outcome: execution.outcome,
      summary: execution.summary,
      ...(execution.receipt ? { receipt: execution.receipt } : {}),
    });
    if (!returnedResult.ok) {
      this.rejectChild({
        issueCode: returnedResult.issueCode,
        callerCall,
        childRoleId: openedChild.call.roleId,
      });
    }
    const returned = returnedResult.commit;
    if (!isValidChildReturnTransition(returned, openedChild.commit)) {
      this.rejectChild({
        issueCode: "child_return_transition_invalid",
        callerCall,
        childRoleId: openedChild.call.roleId,
      });
    }

    const returnCommit = requireRoleCallChildReturnCommit(returned);
    let resume;
    let resumedCall;
    try {
      resume = projectRoleChildReturnContext(input.ledger, returned);
      resumedCall = requireResumedCallerCall(returnCommit, callerCall);
    } catch {
      this.rejectChild({
        issueCode: "child_return_projection_invalid",
        callerCall,
        childRoleId: openedChild.call.roleId,
      });
    }
    if (!isValidResumeProjection(resume, resumedCall)) {
      this.rejectChild({
        issueCode: "caller_resume_projection_invalid",
        callerCall,
        childRoleId: openedChild.call.roleId,
      });
    }

    traceRoleExecutorChildContinued(this.diagnostic, {
      childCallId: openedChild.call.callId,
      childRoleId: openedChild.call.roleId,
      resultRef: returnCommit.effect.resultRef,
      fromActivation: callerCall.activationCount,
      toActivation: resumedCall.activationCount,
      ...(returnCommit.effect.planItemIds
        ? { planItemIds: returnCommit.effect.planItemIds }
        : {}),
      turnCount: input.turnCount,
    });
    return returnCommit;
  }

  private rejectChild(params: {
    issueCode: string;
    callerCall: RoleCallFrame;
    childRoleId?: RuntimeDelegateRoleId;
  }): never {
    const { input } = this.params;
    traceRoleExecutorChildRejected(this.diagnostic, {
      issueCode: params.issueCode,
      childRoleId: params.childRoleId ?? input.roleId,
      fromActivation: params.callerCall.activationCount,
      turnCount: input.turnCount,
    });
    throw childInvocationError(params.callerCall.roleId, params.issueCode);
  }
}
