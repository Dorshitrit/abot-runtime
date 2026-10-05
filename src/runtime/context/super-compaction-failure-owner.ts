import type {
  ExecutionPolicyAuthoritySnapshot,
  RoleCallLedgerHead,
} from "../orchestration/role-calls/contracts.js";
import { hasSuperContextContract } from "./super-context-policy.js";
import {
  createOwnedSuperContextFailure,
  SuperContextFailure,
  type SuperContextFailureBinding,
  type SuperContextFailureCode,
} from "./super-context-failure.js";
import { InvalidatedCompactionScopeError } from "./semantic-compaction/scope-quarantine.js";
import { CompactionSourceInvariantError } from "./compaction-source-invariant.js";

export type SuperCompactionFailureOwner = Readonly<{
  binding: SuperContextFailureBinding;
  head?: RoleCallLedgerHead;
}>;

/** Only canonical SUPER invocation boundaries may opt into owned failures. */
export function superCompactionFailureOwner(
  authority: ExecutionPolicyAuthoritySnapshot,
  binding: SuperContextFailureBinding,
): SuperCompactionFailureOwner | undefined {
  if (!hasSuperContextContract(authority, binding.contractId)) return undefined;
  return Object.freeze({ binding: Object.freeze({ ...binding }) });
}

/** Provider awaits stay outside this synchronous context-owned boundary. */
export function withSuperCompactionFailure<T>(
  owner: SuperCompactionFailureOwner | undefined,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (cause: unknown) {
    if (!owner || cause instanceof SuperContextFailure) throw cause;
    const code = ownedSourceInvariantCode(cause);
    if (!code) throw cause;
    const binding =
      cause instanceof CompactionSourceInvariantError && cause.sourceRef
        ? { ...owner.binding, sourceRef: cause.sourceRef }
        : owner.binding;
    if (owner.head) {
      throw createOwnedSuperContextFailure({
        code,
        head: owner.head,
        cause,
        binding,
      });
    }
    // The role return boundary independently checks this trusted invocation
    // binding against its canonical ledger head before routing the failure.
    throw new SuperContextFailure(code, binding, cause);
  }
}

function ownedSourceInvariantCode(
  cause: unknown,
): SuperContextFailureCode | undefined {
  if (cause instanceof InvalidatedCompactionScopeError) return cause.code;
  if (!(cause instanceof Error)) return undefined;
  switch (cause.message) {
    case "operation_supervision_evidence_message_binding_invalid":
    case "operation_supervision_evidence_context_binding_invalid":
      return "context_compaction_execution_owner_invalid";
    case "operation_supervision_evidence_exact_binding_invalid":
    case "operation_supervision_evidence_exact_lane_invalid":
      return "context_compaction_source_identity_conflict";
    case "context_compaction_source_identity_conflict":
    case "request_tool_results_compaction_source_missing":
    case "request_tool_results_compaction_fingerprint_mismatch":
    case "context_compaction_scope_invalidated":
    case "context_compaction_checkpoint_revision_invalid":
    case "context_compaction_checkpoint_content_invalid":
    case "context_compaction_checkpoint_source_invalid":
    case "context_compaction_checkpoint_invalid":
    case "context_compaction_execution_owner_invalid":
    case "context_compaction_snapshot_source_incompatible":
      return cause.message;
    default:
      return undefined;
  }
}
