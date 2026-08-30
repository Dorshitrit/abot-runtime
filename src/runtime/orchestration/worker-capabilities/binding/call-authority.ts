import { classifyRuntimeErrorType } from "../../../observability/error-type.js";
import {
  hasRoleCallCapabilityAuthority,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../../role-calls/index.js";
import type { WorkerCapabilityExecutionFreshness } from "../contracts.js";
import {
  traceWorkerCapabilitySelectionRejected,
  type WorkerCapabilityDiagnosticContext,
} from "../diagnostics.js";
import {
  isWorkerCapabilityBindingRejection,
  workerCapabilityBindingRejection,
} from "./binding-rejection.js";

type LiveCapabilityCall = Readonly<{
  currentHead: RoleCallLedgerHead;
  currentCall: RoleCallFrame;
}>;

type InitialBindingAuthority =
  | Readonly<{ ok: true; authoritativeCall: RoleCallFrame }>
  | Readonly<{ ok: false; issueCode: string }>;

type SteeringUpdate = Readonly<{ sequence: number; text: string }>;

type SteeringToken = Readonly<{
  kind: "request_steering_v1";
  version: number;
  updates: readonly SteeringUpdate[];
}>;

type FreshnessSource = Readonly<{
  token: SteeringToken;
  isCurrent(): boolean;
}>;

export function inspectInitialBindingAuthority(params: {
  requestId: string;
  boundCall: RoleCallFrame;
  initialHead: RoleCallLedgerHead;
}): InitialBindingAuthority {
  const authoritativeCall = params.initialHead.state.calls.find(
    (call) => call.callId === params.boundCall.callId,
  );
  if (params.initialHead.state.requestId !== params.requestId) {
    return { ok: false, issueCode: "request_id_mismatch" };
  }
  if (params.initialHead.state.activeCallId !== params.boundCall.callId) {
    return { ok: false, issueCode: "call_not_current" };
  }
  if (!authoritativeCall) {
    return { ok: false, issueCode: "current_call_unavailable" };
  }
  const issueCode = validateExecutionCall(
    params.boundCall,
    authoritativeCall,
    params.initialHead,
  );
  if (issueCode) return { ok: false, issueCode };
  return { ok: true, authoritativeCall };
}

export function resolveLiveCapabilityCall(params: {
  requestId: string;
  boundCall: RoleCallFrame;
  ledger: RoleCallLedger;
  diagnostic: WorkerCapabilityDiagnosticContext;
  attemptedCapabilityId?: string;
}): LiveCapabilityCall {
  let currentHead: RoleCallLedgerHead;
  let currentCall: RoleCallFrame | undefined;
  try {
    currentHead = params.ledger.current();
    assertLiveRequestAuthority(params, currentHead);
    currentCall = currentHead.state.calls.find(
      (call) => call.callId === params.boundCall.callId,
    );
  } catch (error: unknown) {
    if (isWorkerCapabilityBindingRejection(error)) throw error;
    traceWorkerCapabilitySelectionRejected(params.diagnostic, {
      issueCode: "current_call_read_failed",
      errorType: classifyRuntimeErrorType(error),
    });
    throw workerCapabilityBindingRejection("current_call_read_failed");
  }
  if (!currentCall) {
    traceWorkerCapabilitySelectionRejected(params.diagnostic, {
      issueCode: "current_call_unavailable",
    });
    throw workerCapabilityBindingRejection("current_call_unavailable");
  }
  const bindingIssue = validateExecutionCall(
    params.boundCall,
    currentCall,
    currentHead,
  );
  if (bindingIssue) {
    traceWorkerCapabilitySelectionRejected(params.diagnostic, {
      issueCode: bindingIssue,
      attemptedCallId: currentCall.callId,
      attemptedInvocationAttempt: currentCall.activationCount,
      ...(params.attemptedCapabilityId
        ? { capabilityId: params.attemptedCapabilityId }
        : {}),
    });
    throw workerCapabilityBindingRejection(bindingIssue);
  }
  return { currentHead, currentCall };
}

export function normalizeExecutionFreshness(
  input: WorkerCapabilityExecutionFreshness | undefined,
): WorkerCapabilityExecutionFreshness | undefined {
  if (input === undefined) return undefined;
  if (!isFreshnessSource(input)) return undefined;
  const source = input;
  return Object.freeze({
    token: Object.freeze({
      kind: "request_steering_v1" as const,
      version: input.token.version,
      updates: Object.freeze(
        input.token.updates.map(({ sequence, text }) =>
          Object.freeze({ sequence, text }),
        ),
      ),
    }),
    isCurrent: () => source.isCurrent(),
  });
}

export function copyBoundCapabilityCall(call: RoleCallFrame): RoleCallFrame {
  return Object.freeze({
    ...call,
    childCallIds: Object.freeze([...call.childCallIds]),
    ...(call.workerCapabilityScope
      ? {
          workerCapabilityScope: Object.freeze({
            catalogGroupIds: Object.freeze([
              ...call.workerCapabilityScope.catalogGroupIds,
            ]),
          }),
        }
      : {}),
  });
}

function assertLiveRequestAuthority(
  params: {
    requestId: string;
    boundCall: RoleCallFrame;
    diagnostic: WorkerCapabilityDiagnosticContext;
  },
  currentHead: RoleCallLedgerHead,
): void {
  if (currentHead.state.requestId !== params.requestId) {
    traceWorkerCapabilitySelectionRejected(params.diagnostic, {
      issueCode: "request_id_mismatch",
    });
    throw workerCapabilityBindingRejection("request_id_mismatch");
  }
  if (currentHead.state.activeCallId !== params.boundCall.callId) {
    traceWorkerCapabilitySelectionRejected(params.diagnostic, {
      issueCode: "call_not_current",
    });
    throw workerCapabilityBindingRejection("call_not_current");
  }
}

function validateExecutionCall(
  boundCall: RoleCallFrame,
  currentCall: RoleCallFrame,
  head: RoleCallLedgerHead,
): string | null {
  if (!isValidActiveRoleCapabilityCall(head, currentCall)) {
    return "worker_call_invalid";
  }
  if (currentCall.callId !== boundCall.callId) return "call_id_mismatch";
  if (currentCall.roleId !== boundCall.roleId) return "worker_call_invalid";
  if (currentCall.parentCallId !== boundCall.parentCallId) {
    return "parent_call_id_mismatch";
  }
  if (currentCall.depth !== boundCall.depth) return "call_depth_mismatch";
  if (currentCall.activationCount !== boundCall.activationCount) {
    return "invocation_attempt_mismatch";
  }
  if (currentCall.workingDirectory !== boundCall.workingDirectory) {
    return "working_directory_mismatch";
  }
  if (
    !sameWorkerCapabilityScope(
      currentCall.workerCapabilityScope,
      boundCall.workerCapabilityScope,
    )
  ) {
    return "worker_capability_scope_mismatch";
  }
  return null;
}

function isValidActiveRoleCapabilityCall(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): boolean {
  if (call.status !== "active") return false;
  if (!Number.isInteger(call.activationCount)) return false;
  if (call.activationCount < 1) return false;
  if (call.resultRef !== null) return false;
  if (
    !hasRoleCallCapabilityAuthority(
      head.policy.authority,
      head.state.rootCallId,
      call,
    )
  ) {
    return false;
  }
  return hasValidRootOrDelegatedIdentity(head, call);
}

function hasValidRootOrDelegatedIdentity(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): boolean {
  const isRoot =
    call.callId === head.state.rootCallId && call.parentCallId === null;
  if (isRoot) return call.depth === 0 && call.objective === null;
  if (call.parentCallId === null) return false;
  if (call.depth < 1) return false;
  if (call.objective === null) return false;
  return call.objective.trim().length > 0;
}

function sameWorkerCapabilityScope(
  left: RoleCallFrame["workerCapabilityScope"],
  right: RoleCallFrame["workerCapabilityScope"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.catalogGroupIds.length !== right.catalogGroupIds.length) {
    return false;
  }
  return left.catalogGroupIds.every(
    (groupId, index) => groupId === right.catalogGroupIds[index],
  );
}

function isFreshnessSource(input: unknown): input is FreshnessSource {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as Readonly<{
    token?: unknown;
    isCurrent?: unknown;
  }>;
  if (typeof candidate.isCurrent !== "function") return false;
  return isSteeringToken(candidate.token);
}

function isSteeringToken(input: unknown): input is SteeringToken {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as Readonly<{
    kind?: unknown;
    version?: unknown;
    updates?: unknown;
  }>;
  if (candidate.kind !== "request_steering_v1") return false;
  if (!Number.isSafeInteger(candidate.version)) return false;
  if ((candidate.version as number) < 0) return false;
  if (!Array.isArray(candidate.updates)) return false;
  if (candidate.updates.length !== candidate.version) return false;
  return candidate.updates.every((update, index) =>
    isValidSteeringUpdate(update, index),
  );
}

function isValidSteeringUpdate(
  input: unknown,
  zeroBasedIndex: number,
): input is SteeringUpdate {
  if (typeof input !== "object" || input === null) return false;
  const update = input as Readonly<{ sequence?: unknown; text?: unknown }>;
  if (update.sequence !== zeroBasedIndex + 1) return false;
  if (typeof update.text !== "string") return false;
  return update.text.trim().length > 0;
}
