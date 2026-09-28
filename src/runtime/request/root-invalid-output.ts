import { projectInvalidOutputProgress } from "./root-invalid-output-progress.js";
import type { DegradedFinalizationInput } from "../steps/degraded-finalization/contract.js";
import {
  resolveModelOutputFailure,
  type ModelOutputFailure,
} from "../model/invalid-output-failure.js";
import { ModelOutputIncompleteError } from "../model/provider-completion.js";
import { traceDebug } from "../observability/debug-logger.js";
import type {
  RoleCallLedger,
  RoleCallLedgerHead,
  RoleCallFrame,
} from "../orchestration/role-calls/index.js";
import { RUNTIME_ROOT_ROLE_ID } from "../orchestration/roles.js";
import { runModelAuthoredDegradedFinalization } from "../steps/degraded-finalization/model-authored.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import type { RequestRunnerResult } from "./result.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";
import { commitSupervisorResponse } from "./root-response-commit.js";
import { resolveRoleCallTransactions } from "../orchestration/role-calls/index.js";
import type { SupervisorRootFailureStage } from "./supervisor-root-execution-diagnostics.js";

type RootModelOutputFailure = ModelOutputFailure &
  Readonly<{ steeringVersion?: number }>;

type InvalidRootOutputResult =
  | Readonly<{ kind: "continue" }>
  | Readonly<{ kind: "complete"; result: RequestRunnerResult }>;

/** Finalizes known model-output failures at the still-current root boundary. */
export async function finalizeInvalidRootOutput(params: {
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
  expectedHead: RoleCallLedgerHead | undefined;
  failureStage: SupervisorRootFailureStage;
  steeringVersion: number;
  publishDeferredTitle?: (() => Promise<void>) | undefined;
  error: unknown;
}): Promise<InvalidRootOutputResult | undefined> {
  if (!isRootModelOutputStage(params.failureStage)) return undefined;
  const failure = resolveRootModelOutputFailure(params.request, params.error);
  if (!failure) return undefined;
  if (!isRootModelOutputStep(params.request, failure.modelStep))
    return undefined;
  params.request.abortSignal.throwIfAborted();
  const steering = resolveRequestSteeringInbox(params.request.requestSteering);
  const steeringVersion = failure.steeringVersion ?? params.steeringVersion;
  if (!steering.isCurrent(steeringVersion)) return { kind: "continue" };

  const head = params.ledger.current();
  const root = head.state.calls.find(
    (call) => call.callId === head.state.rootCallId,
  );
  if (!canFinalizeInvalidOutputAtActiveRoot(head, params.expectedHead, root)) {
    return undefined;
  }

  traceDebug("runtime.request", "root.invalid_output.finalizing", {
    requestId: params.request.requestId,
    callId: root.callId,
    sourceRevision: head.revision,
    failureStage: params.failureStage,
    ...failure,
    steeringVersion,
  });
  const input: DegradedFinalizationInput = {
    problem: { stage: failure.validationStage, code: failure.code },
    progress: projectInvalidOutputProgress(head),
  };
  let response: string;
  try {
    response = await runModelAuthoredDegradedFinalization({
      request: params.request,
      input,
      maxResponseChars: head.policy.limits.maxResponseChars,
    });
  } catch (error: unknown) {
    params.request.abortSignal.throwIfAborted();
    if (!steering.isCurrent(steeringVersion)) return { kind: "continue" };
    throw error;
  }
  params.request.abortSignal.throwIfAborted();
  if (!steering.isCurrent(steeringVersion)) return { kind: "continue" };
  if (!isInvalidOutputHeadUnchanged(params.ledger.current(), head))
    throw params.error;
  if (!steering.seal(steeringVersion)) return { kind: "continue" };
  await params.publishDeferredTitle?.();
  params.request.abortSignal.throwIfAborted();
  const output = await commitSupervisorResponse({
    transactions: resolveRoleCallTransactions(params.ledger),
    expectedHead: head,
    callId: root.callId,
    response,
  });
  traceDebug("runtime.request", "root.invalid_output.finalized", {
    requestId: params.request.requestId,
    callId: root.callId,
    code: failure.code,
    modelStep: failure.modelStep,
  });
  return {
    kind: "complete",
    result: {
      output,
      ...(params.request.executionPolicy.authority.terminalTextMode === "exact"
        ? { outputTextMode: "exact" as const }
        : {}),
    },
  };
}

function resolveRootModelOutputFailure(
  request: RequestExecutionScope,
  error: unknown,
): RootModelOutputFailure | undefined {
  if (!(error instanceof ModelOutputIncompleteError))
    return resolveModelOutputFailure(error);
  if (!error.modelStep) return undefined;
  if (!isRootAuthoredOutputStep(request, error.modelStep)) return undefined;
  return Object.freeze({
    code: error.code,
    modelStep: error.modelStep,
    validationStage: error.stage,
    steeringVersion: error.steeringVersion,
    issues: [],
  });
}

function isRootModelOutputStage(stage: SupervisorRootFailureStage): boolean {
  return stage === "decide" || stage === "compose_response";
}

function isRootModelOutputStep(
  request: RequestExecutionScope,
  modelStep: string,
): boolean {
  if (modelStep === "context.compact") return true;
  return isRootAuthoredOutputStep(request, modelStep);
}

function isRootAuthoredOutputStep(
  request: RequestExecutionScope,
  modelStep: string,
): boolean {
  const contract = request.executionPolicy.rootContract;
  if (modelStep === contract.decisionModelStep) return true;
  return modelStep === contract.responseModelStep;
}

function canFinalizeInvalidOutputAtActiveRoot(
  head: RoleCallLedgerHead,
  expectedHead: RoleCallLedgerHead | undefined,
  root: RoleCallFrame | undefined,
): root is RoleCallFrame {
  if (!isInvalidOutputHeadUnchanged(head, expectedHead)) return false;
  if (!root) return false;
  if (root.roleId !== RUNTIME_ROOT_ROLE_ID) return false;
  if (root.status !== "active") return false;
  if (head.state.activeCallId !== root.callId) return false;
  return head.state.phase === "running";
}

function isInvalidOutputHeadUnchanged(
  head: RoleCallLedgerHead,
  expectedHead: RoleCallLedgerHead | undefined,
): boolean {
  return head === expectedHead;
}
