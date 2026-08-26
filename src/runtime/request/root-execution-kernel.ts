import { projectRequestToolResults } from "../context/request-tool-results.js";
import { emitRuntimeStatus } from "../events/runtime-status.js";
import {
  resolveRoleCallTransactions,
  type RoleCallChildReturnCommit,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
  type RoleCallTransactions,
  type RoleChildReturnContext,
} from "../orchestration/role-calls/index.js";
import { RUNTIME_ROOT_ROLE_ID } from "../orchestration/roles.js";
import {
  createRoleCapabilityBinding,
  projectWorkerCapabilityCatalogGroups,
  type WorkerCapabilityCatalogGroup,
  type WorkerCapabilityExecutionFreshness,
} from "../orchestration/worker-capabilities/index.js";
import {
  type CompiledRequestExecutionPolicy,
  type RequestExecutionScope,
} from "./execution-scope.js";
import type { RequestObservation, RequestRunnerResult } from "./result.js";
import type {
  RootContractAdapter,
  RootContractCallIdentity,
  RootContractDecision,
} from "./root-contract.js";
import {
  projectRequestSteeringSnapshot,
  resolveRequestSteeringInbox,
} from "./request-steering.js";
import {
  type SupervisorRootDiagnosticContext,
  type SupervisorRootFailureStage,
  traceSupervisorRootAcknowledgementPublished,
  traceSupervisorRootActivationFailed,
  traceSupervisorRootActivationStarted,
  traceSupervisorRootObservationHandoffBound,
  traceSupervisorRootInvocationSuperseded,
  traceSupervisorRootResponseSuperseded,
} from "./supervisor-root-execution-diagnostics.js";

export type {
  RootContractCallIdentity,
  RootContractDecision,
  RootContractDecisionOutcome,
} from "./root-contract.js";
export type { CompiledRequestExecutionPolicy } from "./execution-scope.js";

export type RequestRootContractAdapter =
  RootContractAdapter<RequestExecutionScope>;

type RootObservationHandoff = Readonly<{
  callerCallId: string;
  childCallId: string;
  resultRef: string;
  finalObservation: RequestObservation;
}>;

type RootActivation = Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  callIdentity: RootContractCallIdentity;
}>;

type RootDecisionActivation = RootActivation &
  Readonly<{
    decision: RootContractDecision;
    decisionSteeringVersion: number;
    requiresFreshPresentation: boolean;
    deferPresentation: boolean;
  }>;

type RootActivationAttempt = {
  failureStage: SupervisorRootFailureStage;
  head?: RoleCallLedgerHead;
  call?: RoleCallFrame;
};

type RootLoopControl =
  | Readonly<{ kind: "continue" }>
  | Readonly<{ kind: "complete"; result: RequestRunnerResult }>;

const CONTINUE_ROOT_EXECUTION = Object.freeze({
  kind: "continue" as const,
});

export async function runRootExecutionKernel(params: {
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
}): Promise<RequestRunnerResult> {
  return new RootExecutionSession(params).run();
}

class RootExecutionSession {
  private readonly request: RequestExecutionScope;
  private readonly ledger: RoleCallLedger;
  private readonly transactions: RoleCallTransactions;
  private readonly policy: CompiledRequestExecutionPolicy;
  private readonly diagnostic: SupervisorRootDiagnosticContext;
  private readonly requestSteering: ReturnType<
    typeof resolveRequestSteeringInbox
  >;
  private resume: RoleChildReturnContext | undefined;
  private observationHandoff: RootObservationHandoff | undefined;
  private availableWorkerCapabilityCatalog:
    | readonly WorkerCapabilityCatalogGroup[]
    | undefined;
  private acknowledgementPublished = false;
  private titlePublished = false;

  constructor(params: {
    request: RequestExecutionScope;
    ledger: RoleCallLedger;
  }) {
    this.request = params.request;
    this.ledger = params.ledger;
    this.transactions = resolveRoleCallTransactions(params.ledger);
    this.policy = params.request.executionPolicy;
    this.diagnostic = Object.freeze({
      requestId: params.request.requestId,
      allowedRoleIds: this.policy.roleExecutors.roleIds,
    });
    this.requestSteering = resolveRequestSteeringInbox(
      params.request.requestSteering,
    );
  }

  async run(): Promise<RequestRunnerResult> {
    // Every non-terminal decision consumes a ledger-bounded child call.
    for (;;) {
      const control = await this.runActivation();
      if (control.kind === "complete") {
        return control.result;
      }
    }
  }

  private async runActivation(): Promise<RootLoopControl> {
    const attempt: RootActivationAttempt = {
      failureStage: "project_activation",
    };
    try {
      const activation = this.resolveActivation(attempt);
      const decisionActivation = await this.decide(activation, attempt);
      if (
        !(await this.publishImmediatePresentation(decisionActivation, attempt))
      ) {
        return CONTINUE_ROOT_EXECUTION;
      }
      return await this.executeDecision(decisionActivation, attempt);
    } catch (error: unknown) {
      traceSupervisorRootActivationFailed({
        diagnostic: this.diagnostic,
        failureStage: attempt.failureStage,
        error,
        ...(attempt.head ? { head: attempt.head } : {}),
        ...(attempt.call ? { call: attempt.call } : {}),
        ...(this.resume ? { resume: this.resume } : {}),
      });
      throw error;
    }
  }

  private resolveActivation(attempt: RootActivationAttempt): RootActivation {
    const head = this.ledger.current();
    attempt.head = head;
    const callIdentity = this.policy.rootContract.projectCallIdentity(head);
    const call = requireRootCallFrame({ head, callId: callIdentity.callId });
    attempt.call = call;
    traceSupervisorRootActivationStarted({
      diagnostic: this.diagnostic,
      head,
      call,
      ...(this.resume ? { resume: this.resume } : {}),
    });
    if (this.resume) {
      emitSupervisorResumeStatus(this.request);
    }
    return Object.freeze({ head, call, callIdentity });
  }

  private async decide(
    activation: RootActivation,
    attempt: RootActivationAttempt,
  ): Promise<RootDecisionActivation> {
    attempt.failureStage = "project_worker_catalog";
    this.availableWorkerCapabilityCatalog ??=
      this.policy.authority.capabilityAuthorities.includes("root") ||
      (this.policy.roleExecutors.roleIds.includes("worker") &&
        this.policy.authority.capabilityAuthorities.includes("worker"))
        ? projectWorkerCapabilityCatalogGroups(
            this.request.workerCapabilities.provider.getDescriptors(),
          )
        : Object.freeze([]);
    attempt.failureStage = "decide";
    const decisionToolResults = projectRequestToolResults({
      ledger: this.ledger,
      head: activation.head,
      modelStep: this.policy.rootContract.decisionModelStep,
      callId: activation.call.callId,
    });
    const decisionOutcome = await this.policy.rootContract.decide(
      this.request,
      {
        head: activation.head,
        callFrame: activation.call,
        call: activation.callIdentity,
        toolResults: decisionToolResults,
        includeAcknowledgement:
          this.resume === undefined && !this.acknowledgementPublished,
        includeTitle:
          this.resume === undefined &&
          !this.titlePublished &&
          this.request.shouldGenerateSessionTitle,
        allowedRoleIds: this.policy.roleExecutors.roleIds,
        availableWorkerCapabilityCatalog: this.availableWorkerCapabilityCatalog,
        ...(this.resume ? { resume: this.resume } : {}),
      },
    );
    const requiresFreshPresentation =
      this.policy.rootContract.deferRespondPresentation === true;
    return Object.freeze({
      ...activation,
      decision: decisionOutcome.decision,
      decisionSteeringVersion: decisionOutcome.steeringVersion,
      requiresFreshPresentation,
      deferPresentation:
        requiresFreshPresentation &&
        (decisionOutcome.decision.action === "respond" ||
          decisionOutcome.decision.action === "blocked"),
    });
  }

  private async publishImmediatePresentation(
    activation: RootDecisionActivation,
    attempt: RootActivationAttempt,
  ): Promise<boolean> {
    const { decision } = activation;
    if (activation.deferPresentation) {
      return true;
    }
    if (decision.title !== undefined) {
      if (
        activation.requiresFreshPresentation &&
        !this.isInvocationCurrent(activation.decisionSteeringVersion)
      ) {
        return false;
      }
      attempt.failureStage = "publish_title";
      await this.request.onSessionTitle(decision.title);
      this.titlePublished = true;
    }
    if (decision.acknowledgement !== undefined) {
      if (
        activation.requiresFreshPresentation &&
        !this.isInvocationCurrent(activation.decisionSteeringVersion)
      ) {
        return false;
      }
      attempt.failureStage = "publish_acknowledgement";
      this.request.onAcknowledgement(decision.acknowledgement);
      this.acknowledgementPublished = true;
      traceSupervisorRootAcknowledgementPublished({
        diagnostic: this.diagnostic,
        head: activation.head,
        call: activation.call,
        acknowledgementLength: decision.acknowledgement.length,
      });
    }
    return true;
  }

  private async executeDecision(
    activation: RootDecisionActivation,
    attempt: RootActivationAttempt,
  ): Promise<RootLoopControl> {
    const { decision } = activation;
    if (decision.action === "invoke_role") {
      return this.invokeRole(activation, decision, attempt);
    }
    if (decision.action === "reconsider_capability_selection") {
      return this.reconsiderCapabilitySelection(activation, decision, attempt);
    }
    if (decision.action === "update_capability_scope") {
      return this.updateCapabilityScope(activation, decision, attempt);
    }
    if (
      decision.action === "invoke_capability" ||
      decision.action === "invoke_capabilities"
    ) {
      return this.invokeCapabilities(activation, decision, attempt);
    }
    return this.completeResponse(activation, decision, attempt);
  }

  private async invokeRole(
    activation: RootActivation & Readonly<{ decisionSteeringVersion: number }>,
    decision: Extract<RootContractDecision, { action: "invoke_role" }>,
    attempt: RootActivationAttempt,
  ): Promise<RootLoopControl> {
    if (!this.isInvocationCurrent(activation.decisionSteeringVersion)) {
      return CONTINUE_ROOT_EXECUTION;
    }
    attempt.failureStage = "invoke_child";
    const child = await this.policy.roleExecutors.invokeChild({
      requestId: this.request.requestId,
      context: this.request,
      callerCall: activation.call,
      ledger: this.ledger,
      expectedHead: activation.head,
      roleId: decision.roleId,
      objective: decision.objective,
      ...(decision.roleId === "planner" || decision.roleId === "worker"
        ? { workingDirectory: decision.workingDirectory }
        : {}),
      ...(decision.roleId === "worker" && decision.workerCapabilityScope
        ? { workerCapabilityScope: decision.workerCapabilityScope }
        : {}),
      turnCount: activation.call.activationCount,
    });
    attempt.failureStage = "project_resume";
    this.resume = this.policy.rootContract.projectResume(
      this.ledger,
      child.returnCommit,
    );
    if (child.execution.value?.finalObservation) {
      attempt.failureStage = "bind_observation";
      this.observationHandoff = bindSupervisorObservationHandoff({
        diagnostic: this.diagnostic,
        returnCommit: child.returnCommit,
        resume: this.resume,
        finalObservation: child.execution.value.finalObservation,
        replaced: this.observationHandoff !== undefined,
      });
    }
    return CONTINUE_ROOT_EXECUTION;
  }

  private async reconsiderCapabilitySelection(
    activation: RootActivation & Readonly<{ decisionSteeringVersion: number }>,
    decision: Extract<
      RootContractDecision,
      { action: "reconsider_capability_selection" }
    >,
    attempt: RootActivationAttempt,
  ): Promise<RootLoopControl> {
    if (!this.isInvocationCurrent(activation.decisionSteeringVersion)) {
      return CONTINUE_ROOT_EXECUTION;
    }
    attempt.failureStage = "apply_root_transition";
    const reconsidered = await this.transactions.reconsiderCapabilitySelection({
      expectedHead: activation.head,
      callId: activation.call.callId,
      invocationAttempt: activation.call.activationCount,
      steeringVersion: activation.decisionSteeringVersion,
      selection: decision.selection,
    });
    if (!reconsidered.ok) {
      throw new Error(`role_call_ledger_rejected:${reconsidered.issueCode}`);
    }
    return CONTINUE_ROOT_EXECUTION;
  }

  private async updateCapabilityScope(
    activation: RootActivation & Readonly<{ decisionSteeringVersion: number }>,
    decision: Extract<
      RootContractDecision,
      { action: "update_capability_scope" }
    >,
    attempt: RootActivationAttempt,
  ): Promise<RootLoopControl> {
    if (!this.isInvocationCurrent(activation.decisionSteeringVersion)) {
      return CONTINUE_ROOT_EXECUTION;
    }
    attempt.failureStage = "invoke_child";
    const updated = await this.transactions.updateCapabilityScope({
      expectedHead: activation.head,
      callId: activation.call.callId,
      invocationAttempt: activation.call.activationCount,
      mode: decision.mode,
      catalogGroupIds: decision.catalogGroupIds,
    });
    if (!updated.ok) {
      throw new Error(`role_call_ledger_rejected:${updated.issueCode}`);
    }
    return CONTINUE_ROOT_EXECUTION;
  }

  private async invokeCapabilities(
    activation: RootActivation & Readonly<{ decisionSteeringVersion: number }>,
    decision: Extract<
      RootContractDecision,
      { action: "invoke_capability" | "invoke_capabilities" }
    >,
    attempt: RootActivationAttempt,
  ): Promise<RootLoopControl> {
    if (!this.isInvocationCurrent(activation.decisionSteeringVersion)) {
      return CONTINUE_ROOT_EXECUTION;
    }
    attempt.failureStage = "invoke_child";
    let head = activation.head;
    let call = activation.call;
    if (decision.workingDirectory !== undefined) {
      const established = await this.transactions.establishWorkingDirectory({
        expectedHead: head,
        callId: call.callId,
        invocationAttempt: call.activationCount,
        workingDirectory: decision.workingDirectory,
      });
      if (!established.ok) {
        throw new Error(`role_call_ledger_rejected:${established.issueCode}`);
      }
      head = established.commit.head;
      attempt.head = head;
      call = requireRootCallFrame({ head, callId: call.callId });
      attempt.call = call;
    }
    const binding = createRoleCapabilityBinding({
      requestId: this.request.requestId,
      context: this.request.workerCapabilities.executionContext,
      call,
      ledger: this.ledger,
      adapters: this.request.workerCapabilities.provider.getAdapters(),
      ...(this.policy.authority.capabilityAuthorities.includes("root")
        ? {
            executionFreshness: createRootExecutionFreshness({
              requestSteering: this.requestSteering,
              steeringVersion: activation.decisionSteeringVersion,
            }),
          }
        : {}),
    });
    if (decision.action === "invoke_capability") {
      await binding.execute({
        capabilityId: decision.capabilityId,
        intent: decision.intent,
        controls: decision.controls,
      });
    } else {
      await binding.executeBatch({ invocations: decision.invocations });
    }
    this.resume = undefined;
    return CONTINUE_ROOT_EXECUTION;
  }

  private async completeResponse(
    activation: RootDecisionActivation,
    decision: Extract<RootContractDecision, { action: "respond" | "blocked" }>,
    attempt: RootActivationAttempt,
  ): Promise<RootLoopControl> {
    if (
      !this.isResponseCurrent(
        activation.decisionSteeringVersion,
        "before_response",
      )
    ) {
      return CONTINUE_ROOT_EXECUTION;
    }
    attempt.failureStage = "project_observation";
    const finalObservation = this.observationHandoff
      ? projectSupervisorFinalObservation(this.observationHandoff, this.resume)
      : undefined;
    attempt.failureStage = "compose_response";
    const response =
      decision.action === "blocked"
        ? decision.response
        : await this.policy.rootContract.authorResponse(this.request, {
            head: activation.head,
            callFrame: activation.call,
            steeringVersion: activation.decisionSteeringVersion,
            call: activation.callIdentity,
            toolResults: projectRequestToolResults({
              ledger: this.ledger,
              head: activation.head,
              modelStep: this.policy.rootContract.responseModelStep,
              callId: activation.call.callId,
            }),
            ...(this.resume ? { resume: this.resume } : {}),
          });
    if (
      !this.isResponseCurrent(
        activation.decisionSteeringVersion,
        "after_response",
      )
    ) {
      return CONTINUE_ROOT_EXECUTION;
    }
    attempt.failureStage = "seal_response";
    this.request.abortSignal.throwIfAborted();
    if (!this.requestSteering.seal(activation.decisionSteeringVersion)) {
      this.traceResponseSuperseded(activation.decisionSteeringVersion, "seal");
      return CONTINUE_ROOT_EXECUTION;
    }
    await this.publishDeferredPresentation(activation, attempt);
    attempt.failureStage = "commit_response";
    const output = await commitSupervisorResponse({
      transactions: this.transactions,
      expectedHead: activation.head,
      callId: activation.call.callId,
      response,
    });
    return Object.freeze({
      kind: "complete" as const,
      result: Object.freeze({
        output,
        ...(this.policy.authority.terminalTextMode === "exact"
          ? { outputTextMode: "exact" as const }
          : {}),
        ...(finalObservation ? { finalObservation } : {}),
      }),
    });
  }

  private async publishDeferredPresentation(
    activation: RootDecisionActivation,
    attempt: RootActivationAttempt,
  ): Promise<void> {
    if (!activation.deferPresentation) {
      return;
    }
    if (activation.decision.title !== undefined) {
      attempt.failureStage = "publish_title";
      await this.request.onSessionTitle(activation.decision.title);
      this.titlePublished = true;
    }
    if (activation.decision.acknowledgement !== undefined) {
      attempt.failureStage = "publish_acknowledgement";
      this.request.onAcknowledgement(activation.decision.acknowledgement);
      this.acknowledgementPublished = true;
      traceSupervisorRootAcknowledgementPublished({
        diagnostic: this.diagnostic,
        head: activation.head,
        call: activation.call,
        acknowledgementLength: activation.decision.acknowledgement.length,
      });
    }
  }

  private isInvocationCurrent(decisionSteeringVersion: number): boolean {
    if (this.requestSteering.isCurrent(decisionSteeringVersion)) {
      return true;
    }
    traceSupervisorRootInvocationSuperseded({
      diagnostic: this.diagnostic,
      decisionSteeringVersion,
      currentSteeringVersion: this.requestSteering.snapshot().version,
    });
    return false;
  }

  private isResponseCurrent(
    decisionSteeringVersion: number,
    phase: "before_response" | "after_response",
  ): boolean {
    if (this.requestSteering.isCurrent(decisionSteeringVersion)) {
      return true;
    }
    this.traceResponseSuperseded(decisionSteeringVersion, phase);
    return false;
  }

  private traceResponseSuperseded(
    decisionSteeringVersion: number,
    phase: "before_response" | "after_response" | "seal",
  ): void {
    traceSupervisorRootResponseSuperseded({
      diagnostic: this.diagnostic,
      decisionSteeringVersion,
      currentSteeringVersion: this.requestSteering.snapshot().version,
      phase,
    });
  }
}

function createRootExecutionFreshness(params: {
  requestSteering: ReturnType<typeof resolveRequestSteeringInbox>;
  steeringVersion: number;
}): WorkerCapabilityExecutionFreshness {
  const snapshot = projectRequestSteeringSnapshot(
    params.requestSteering,
    params.steeringVersion,
  );
  return Object.freeze({
    token: Object.freeze({
      kind: "request_steering_v1" as const,
      version: snapshot.version,
      updates: Object.freeze(
        snapshot.updates.map(({ sequence, text }) =>
          Object.freeze({ sequence, text }),
        ),
      ),
    }),
    isCurrent: () => params.requestSteering.isCurrent(snapshot.version),
  });
}

function bindSupervisorObservationHandoff(params: {
  diagnostic: SupervisorRootDiagnosticContext;
  returnCommit: RoleCallChildReturnCommit;
  resume: RoleChildReturnContext;
  finalObservation: RequestObservation;
  replaced: boolean;
}): RootObservationHandoff {
  const { callerCallId, childCallId, resultRef } = params.returnCommit.effect;
  if (
    params.resume.callerCallId !== callerCallId ||
    params.resume.returnedChildCallId !== childCallId ||
    params.resume.returnedResultRef !== resultRef ||
    !params.resume.completedChildren.some(
      (child) =>
        child.callerCallId === callerCallId &&
        child.childCallId === childCallId &&
        child.resultRef === resultRef,
    )
  ) {
    throw new Error("supervisor_observation_handoff_source_invalid");
  }
  const handoff = Object.freeze({
    callerCallId,
    childCallId,
    resultRef,
    finalObservation: params.finalObservation,
  });
  traceSupervisorRootObservationHandoffBound({
    diagnostic: params.diagnostic,
    callerCallId,
    childCallId,
    resultRef,
    replaced: params.replaced,
    observationContentLength: params.finalObservation.observationContent.length,
  });
  return handoff;
}

function projectSupervisorFinalObservation(
  handoff: RootObservationHandoff,
  resume: RoleChildReturnContext | undefined,
): RequestObservation {
  if (
    resume?.callerCallId !== handoff.callerCallId ||
    !resume.completedChildren.some(
      (child) =>
        child.callerCallId === handoff.callerCallId &&
        child.childCallId === handoff.childCallId &&
        child.resultRef === handoff.resultRef,
    )
  ) {
    throw new Error("supervisor_observation_handoff_source_invalid");
  }
  return handoff.finalObservation;
}

function emitSupervisorResumeStatus(request: RequestExecutionScope): void {
  emitRuntimeStatus(request, {
    stage: "supervisor",
    phase: "resuming",
    message: "Processing the delegated result...",
  });
}

function requireRootCallFrame(params: {
  head: RoleCallLedgerHead;
  callId: string;
}): RoleCallFrame {
  const call = params.head.state.calls.find(
    (candidate) => candidate.callId === params.callId,
  );
  if (
    !call ||
    call.callId !== params.head.state.rootCallId ||
    call.parentCallId !== null ||
    call.roleId !== RUNTIME_ROOT_ROLE_ID ||
    call.depth !== 0 ||
    call.status !== "active"
  ) {
    throw new Error("supervisor_call_frame_missing");
  }
  return call;
}

async function commitSupervisorResponse(params: {
  transactions: RoleCallTransactions;
  expectedHead: RoleCallLedgerHead;
  callId: string;
  response: string;
}): Promise<string> {
  const committed = await params.transactions.completeRootResponse({
    expectedHead: params.expectedHead,
    callId: params.callId,
    response: params.response,
  });
  if (!committed.ok) {
    throw new Error(`role_call_ledger_rejected:${committed.issueCode}`);
  }
  const output = committed.commit.head.state.rootResponse;
  if (!output) {
    throw new Error("supervisor_root_response_missing");
  }
  return output;
}
