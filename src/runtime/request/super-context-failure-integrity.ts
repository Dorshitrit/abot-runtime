import type {
  RoleCallFrame,
  RoleCallLedger,
  RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import { validateRoleCallCandidate } from "../orchestration/role-calls/reducer.js";
import { isCurrentRoleCallLedgerHead } from "../orchestration/role-calls/ledger.js";
import { SuperContextFailure } from "../context/super-context-failure.js";
import { hasSuperContextContract } from "../context/super-context-policy.js";
import {
  assertSuperCompactionSourceIntegrity,
  assertSuperCompactionCheckpointIntegrity,
} from "../context/semantic-compaction/super-source-integrity.js";
import type { RequestExecutionScope } from "./execution-scope.js";

export type SuperContextFailureReturnInput = Readonly<{
  error: unknown;
  request: RequestExecutionScope;
  ledger: RoleCallLedger;
  expectedHead: RoleCallLedgerHead;
  call: RoleCallFrame;
  contractId: string;
}>;

export type SuperContextStateInput = Omit<
  SuperContextFailureReturnInput,
  "error"
>;

/** Error identity is not integrity proof: independently validate every authority. */
export function hasSafeSuperContextFailureReturn(
  params: SuperContextFailureReturnInput,
): boolean {
  if (!isOwnedSuperContextFailureInvocation(params)) return false;
  return hasSafeSuperContextState(params);
}

/** Output failures also require independently healthy canonical state. */
export function hasSafeSuperContextState(
  params: SuperContextStateInput,
): boolean {
  if (!hasCurrentSuperContextStateAuthority(params)) return false;
  const head = params.expectedHead;
  try {
    const store = params.request.contextCompactionStore;
    if (!store?.snapshot) return false;
    const integrity = {
      requestId: params.request.requestId,
      prompt: params.request.prompt,
      head,
      store,
    };
    assertSuperCompactionSourceIntegrity(integrity);
    for (const checkpoint of store.snapshot().checkpoints) {
      assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint });
    }
    return true;
  } catch {
    return false;
  }
}

export function hasCurrentSuperFailureAuthority(
  params: SuperContextFailureReturnInput,
): boolean {
  if (!isOwnedSuperContextFailureInvocation(params)) return false;
  return hasCurrentSuperContextStateAuthority(params);
}

function hasCurrentSuperContextStateAuthority(
  params: SuperContextStateInput,
): boolean {
  if (
    !hasSuperContextContract(
      params.request.executionPolicy.authority,
      params.contractId,
    )
  )
    return false;
  if (
    !hasSuperContextContract(
      params.expectedHead.policy.authority,
      params.contractId,
    )
  )
    return false;
  if (params.request.requestId !== params.expectedHead.state.requestId)
    return false;
  const expectedContract =
    params.call.roleId === "supervisor"
      ? "supervisor"
      : `delegated.${params.call.roleId}`;
  if (params.contractId !== expectedContract) return false;
  if (!isCurrentRoleCallLedgerHead(params.ledger, params.expectedHead))
    return false;
  const head = params.expectedHead;
  if (head.state.phase !== "running") return false;
  if (head.state.activeCallId !== params.call.callId) return false;
  if (params.call.status !== "active") return false;
  if (
    head.state.calls.find((call) => call.callId === params.call.callId) !==
    params.call
  )
    return false;
  if (params.request.abortSignal.aborted) return false;
  try {
    if (
      validateRoleCallCandidate({ state: head.state, policy: head.policy })
        .length > 0
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

function isOwnedSuperContextFailureInvocation(
  params: SuperContextFailureReturnInput,
): boolean {
  const failure = params.error;
  if (!(failure instanceof SuperContextFailure)) return false;
  if (failure.code === "context_compaction_snapshot_source_incompatible")
    return false;
  if (
    !hasSuperContextContract(
      params.request.executionPolicy.authority,
      params.contractId,
    )
  )
    return false;
  if (
    !hasSuperContextContract(
      params.expectedHead.policy.authority,
      params.contractId,
    )
  )
    return false;
  const binding = failure.binding;
  if (binding.requestId !== params.request.requestId) return false;
  if (binding.requestId !== params.expectedHead.state.requestId) return false;
  if (binding.callId !== params.call.callId) return false;
  if (binding.parentCallId !== params.call.parentCallId) return false;
  if (binding.contractId !== params.contractId) return false;
  if (binding.invocationAttempt !== params.call.activationCount) return false;
  if (binding.sourceRevision !== params.expectedHead.revision) return false;
  if (!isFailureStepOwnedByContract(binding.modelStep, params.contractId))
    return false;
  const scope =
    params.call.roleId === "worker"
      ? `worker:${params.call.callId}:request-tool-results`
      : `role:${params.call.roleId}:${params.call.callId}:continuation`;
  return binding.scopeId === scope;
}

function isFailureStepOwnedByContract(step: string, contract: string): boolean {
  if (step === "context.compact") return true;
  switch (contract) {
    case "supervisor":
      return step === "supervisor.decision" || step === "supervisor.response";
    case "delegated.planner":
      return step === "planner.decision";
    case "delegated.worker":
      return [
        "worker.decision",
        "worker.result",
        "capability.controls",
        "tool_payload.raw",
      ].includes(step);
    case "delegated.reviewer":
      return step === "reviewer.decision";
    default:
      return false;
  }
}
