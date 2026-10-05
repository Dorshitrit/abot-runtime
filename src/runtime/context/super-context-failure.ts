import type { ModelStep } from "../../shared/model-steps.js";
import type { RoleCallLedgerHead } from "../orchestration/role-calls/contracts.js";
import { hasSuperContextContract } from "./super-context-policy.js";

export type SuperContextFailureCode =
  | "context_compaction_source_identity_conflict"
  | "request_tool_results_compaction_source_missing"
  | "request_tool_results_compaction_fingerprint_mismatch"
  | "context_compaction_scope_invalidated"
  | "context_compaction_checkpoint_revision_invalid"
  | "context_compaction_checkpoint_content_invalid"
  | "context_compaction_checkpoint_source_invalid"
  | "context_compaction_checkpoint_invalid"
  | "context_compaction_execution_owner_invalid"
  | "context_compaction_snapshot_source_incompatible";

export type SuperContextFailureBinding = Readonly<{
  requestId: string;
  callId: string;
  parentCallId: string | null;
  contractId: string;
  invocationAttempt: number;
  sourceRevision: number;
  modelStep: ModelStep;
  phase: string;
  scopeId: string;
  sourceRef?: string;
}>;

/** Internal provenance only; never projects the caught error or source bodies. */
export class SuperContextFailure extends Error {
  readonly binding: SuperContextFailureBinding;
  constructor(
    readonly code: SuperContextFailureCode,
    binding: SuperContextFailureBinding,
    cause: unknown,
  ) {
    super(code, { cause });
    this.name = "SuperContextFailure";
    this.binding = Object.freeze({ ...binding });
  }
}

/** Mint only at an owning context seam with a concrete frozen invocation. */
export function createOwnedSuperContextFailure(params: {
  code: SuperContextFailureCode;
  binding: SuperContextFailureBinding;
  head: RoleCallLedgerHead;
  cause: unknown;
}): SuperContextFailure {
  if (
    !hasSuperContextContract(
      params.head.policy.authority,
      params.binding.contractId,
    )
  ) {
    throw params.cause;
  }
  if (params.head.state.requestId !== params.binding.requestId)
    throw params.cause;
  const call = params.head.state.calls.find(
    ({ callId }) => callId === params.binding.callId,
  );
  if (!call) throw params.cause;
  if (call.parentCallId !== params.binding.parentCallId) throw params.cause;
  if (call.activationCount !== params.binding.invocationAttempt)
    throw params.cause;
  if (params.head.revision !== params.binding.sourceRevision)
    throw params.cause;
  if (!isFailureContractBoundToRole(params.binding.contractId, call.roleId))
    throw params.cause;
  return new SuperContextFailure(params.code, params.binding, params.cause);
}

function isFailureContractBoundToRole(
  contractId: string,
  roleId: string,
): boolean {
  if (contractId === "supervisor") return roleId === "supervisor";
  return contractId === `delegated.${roleId}`;
}
