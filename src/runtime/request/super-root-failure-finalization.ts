import { SuperContextFailure } from "../context/super-context-failure.js";
import type { ModelOutputFailure } from "../model/invalid-output-failure.js";
import { traceDebug } from "../observability/debug-logger.js";
import { RUNTIME_ROOT_ROLE_ID } from "../orchestration/roles.js";
import {
  resolveRoleCallTransactions,
  type RoleCallFrame,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  boundedSuperFailureCode,
  fitsSuperFailureResponse,
} from "../steps/degraded-finalization/super.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import type { RequestRunnerResult } from "./result.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";
import { projectInvalidOutputProgress } from "./root-invalid-output-progress.js";
import { commitSupervisorResponse } from "./root-response-commit.js";
import {
  hasSafeSuperContextFailureReturn,
  hasSafeSuperContextState,
} from "./super-context-failure-integrity.js";
import type { SupervisorRootFailureStage } from "./supervisor-root-execution-diagnostics.js";

/** A valid root transaction is separate from the outer failed request lifecycle. */
export async function finalizeSuperRootFailure(params: {
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
  expectedHead: RoleCallLedgerHead | undefined;
  failureStage: SupervisorRootFailureStage;
  steeringVersion: number;
  publishDeferredTitle?: (() => Promise<void>) | undefined;
  error: unknown;
  failure?:
    | (ModelOutputFailure & Readonly<{ steeringVersion?: number }>)
    | undefined;
}): Promise<
  | Readonly<{ kind: "continue" }>
  | Readonly<{ kind: "complete"; result: RequestRunnerResult }>
  | undefined
> {
  const finalization = params.request.superFailureFinalization;
  if (!finalization) return undefined;
  params.request.abortSignal.throwIfAborted();
  const steering = resolveRequestSteeringInbox(params.request.requestSteering);
  const steeringVersion =
    params.failure?.steeringVersion ?? params.steeringVersion;
  if (!steering.isCurrent(steeringVersion)) return { kind: "continue" };
  finalization.remember(
    params.error,
    params.failure?.validationStage ?? params.failureStage,
  );
  const head = params.ledger.current();
  const root = head.state.calls.find(
    ({ callId }) => callId === head.state.rootCallId,
  );
  if (!canCommitSuperFailure(head, params.expectedHead, root)) return undefined;
  if (!isOwnedSuperRootFailure(params, head, root)) return undefined;
  const explanation = await finalization.explain({
    error: params.error,
    input: {
      problem: {
        stage: params.failure?.validationStage ?? params.failureStage,
        code: boundedSuperFailureCode(params.error),
      },
      progress: projectInvalidOutputProgress(head),
    },
    maxResponseChars: head.policy.limits.maxResponseChars,
    steeringVersion,
  });
  params.request.abortSignal.throwIfAborted();
  if (!steering.isCurrent(steeringVersion)) return { kind: "continue" };
  if (params.ledger.current() !== head) throw params.error;
  if (!isOwnedSuperRootFailure(params, head, root)) throw params.error;
  if (
    !fitsSuperFailureResponse(
      explanation.output,
      head.policy.limits.maxResponseChars,
    )
  ) {
    traceDebug("runtime.request", "super.failure_response_limit_invalid", {
      requestId: params.request.requestId,
      primaryCode: boundedSuperFailureCode(params.error),
      secondaryCode: "degraded_finalization_response_limit_invalid",
    });
    throw params.error;
  }
  if (!steering.seal(steeringVersion)) return { kind: "continue" };
  try {
    await params.publishDeferredTitle?.();
    params.request.abortSignal.throwIfAborted();
    if (params.ledger.current() !== head) throw params.error;
    if (!isOwnedSuperRootFailure(params, head, root)) throw params.error;
    const output = await commitSupervisorResponse({
      transactions: resolveRoleCallTransactions(params.ledger),
      expectedHead: head,
      callId: root.callId,
      response: explanation.output,
    });
    traceDebug("runtime.request", "super.failure_finalized", {
      requestId: params.request.requestId,
      callId: root.callId,
      primaryCode: boundedSuperFailureCode(params.error),
      source: explanation.source,
      disposition: "blocked",
    });
    return { kind: "complete", result: { output, disposition: "blocked" } };
  } catch (error: unknown) {
    params.request.abortSignal.throwIfAborted();
    traceDebug("runtime.request", "super.failure_commit_failed", {
      requestId: params.request.requestId,
      primaryCode: boundedSuperFailureCode(params.error),
      secondaryCode: boundedSuperFailureCode(error),
    });
    throw params.error;
  }
}

function canCommitSuperFailure(
  head: RoleCallLedgerHead,
  expectedHead: RoleCallLedgerHead | undefined,
  root: RoleCallFrame | undefined,
): root is RoleCallFrame {
  if (head !== expectedHead) return false;
  if (!root || root.roleId !== RUNTIME_ROOT_ROLE_ID) return false;
  if (root.status !== "active") return false;
  if (head.state.activeCallId !== root.callId) return false;
  return head.state.phase === "running";
}

function isOwnedSuperRootFailure(
  params: Parameters<typeof finalizeSuperRootFailure>[0],
  head: RoleCallLedgerHead,
  root: RoleCallFrame,
): boolean {
  const state = {
    request: params.request,
    ledger: params.ledger,
    expectedHead: head,
    call: root,
    contractId: params.request.executionPolicy.rootContract.contractId,
  };
  if (params.failure) return hasSafeSuperContextState(state);
  if (!(params.error instanceof SuperContextFailure)) return false;
  return hasSafeSuperContextFailureReturn({ ...state, error: params.error });
}
