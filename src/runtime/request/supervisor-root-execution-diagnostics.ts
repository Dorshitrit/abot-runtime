import { traceDebug } from "../observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../observability/error-type.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleChildReturnContext,
} from "../orchestration/role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../orchestration/roles.js";

const SUPERVISOR_ROOT_LOG_SCOPE = "runtime.supervisor_root";

export type SupervisorRootFailureStage =
  | "project_activation"
  | "project_worker_catalog"
  | "decide"
  | "recall_memory"
  | "publish_title"
  | "publish_acknowledgement"
  | "apply_root_transition"
  | "invoke_child"
  | "project_resume"
  | "bind_observation"
  | "project_observation"
  | "compose_response"
  | "seal_response"
  | "commit_response";

export type SupervisorRootDiagnosticContext = Readonly<{
  requestId: string;
  allowedRoleIds: readonly RuntimeDelegateRoleId[];
}>;

export function traceSupervisorRootActivationStarted(params: {
  diagnostic: SupervisorRootDiagnosticContext;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  resume?: RoleChildReturnContext;
}): void {
  traceDebug(SUPERVISOR_ROOT_LOG_SCOPE, "activation.started", {
    ...projectActivation(params),
  });
}

export function traceSupervisorRootActivationFailed(params: {
  diagnostic: SupervisorRootDiagnosticContext;
  failureStage: SupervisorRootFailureStage;
  error: unknown;
  head?: RoleCallLedgerHead;
  call?: RoleCallFrame;
  resume?: RoleChildReturnContext;
}): void {
  traceDebug(SUPERVISOR_ROOT_LOG_SCOPE, "activation.failed", {
    requestId: params.diagnostic.requestId,
    allowedRoleIds: [...params.diagnostic.allowedRoleIds],
    ...(params.head && params.call
      ? projectActivation({
          diagnostic: params.diagnostic,
          head: params.head,
          call: params.call,
          ...(params.resume ? { resume: params.resume } : {}),
        })
      : {}),
    failureStage: params.failureStage,
    errorType: classifyRuntimeErrorType(params.error),
  });
}

export function traceSupervisorRootObservationHandoffBound(params: {
  diagnostic: SupervisorRootDiagnosticContext;
  callerCallId: string;
  childCallId: string;
  resultRef: string;
  replaced: boolean;
  observationContentLength: number;
}): void {
  traceDebug(SUPERVISOR_ROOT_LOG_SCOPE, "observation_handoff.bound", {
    requestId: params.diagnostic.requestId,
    rootCallId: params.callerCallId,
    callId: params.callerCallId,
    childCallId: params.childCallId,
    resultRef: params.resultRef,
    replaced: params.replaced,
    observationContentLength: params.observationContentLength,
  });
}

export function traceSupervisorRootAcknowledgementPublished(params: {
  diagnostic: SupervisorRootDiagnosticContext;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  acknowledgementLength: number;
}): void {
  traceDebug(SUPERVISOR_ROOT_LOG_SCOPE, "acknowledgement.published", {
    ...projectActivation({
      diagnostic: params.diagnostic,
      head: params.head,
      call: params.call,
    }),
    acknowledgementLength: params.acknowledgementLength,
  });
}

export function traceSupervisorRootResponseSuperseded(params: {
  diagnostic: SupervisorRootDiagnosticContext;
  decisionSteeringVersion: number;
  currentSteeringVersion: number;
  phase: "before_response" | "after_response" | "seal";
}): void {
  traceDebug(SUPERVISOR_ROOT_LOG_SCOPE, "response.superseded", {
    requestId: params.diagnostic.requestId,
    decisionSteeringVersion: params.decisionSteeringVersion,
    currentSteeringVersion: params.currentSteeringVersion,
    phase: params.phase,
  });
}

export function traceSupervisorRootInvocationSuperseded(params: {
  diagnostic: SupervisorRootDiagnosticContext;
  decisionSteeringVersion: number;
  currentSteeringVersion: number;
}): void {
  traceDebug(SUPERVISOR_ROOT_LOG_SCOPE, "invocation.superseded", {
    requestId: params.diagnostic.requestId,
    decisionSteeringVersion: params.decisionSteeringVersion,
    currentSteeringVersion: params.currentSteeringVersion,
    phase: "before_invoke_child",
  });
}

function projectActivation(params: {
  diagnostic: SupervisorRootDiagnosticContext;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  resume?: RoleChildReturnContext;
}): Record<string, unknown> {
  return {
    requestId: params.diagnostic.requestId,
    rootCallId: params.head.state.rootCallId,
    callId: params.call.callId,
    invocationAttempt: params.call.activationCount,
    hasResume: params.resume !== undefined,
    completedDirectChildCount: params.resume?.completedChildren.length ?? 0,
    ...(params.resume
      ? {
          returnedChildCallId: params.resume.returnedChildCallId,
          returnedResultRef: params.resume.returnedResultRef,
        }
      : {}),
    revision: params.head.revision,
    callCount: params.head.state.calls.length,
    maxCalls: params.head.policy.limits.maxCalls,
    remainingCallSlots:
      params.head.policy.limits.maxCalls - params.head.state.calls.length,
    allowedRoleIds: [...params.diagnostic.allowedRoleIds],
  };
}
