import { CompactionSourceInvariantError } from "../compaction-source-invariant.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import { WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../../orchestration/worker-capabilities/payload-contracts.js";
import { projectCanonicalCapabilityResultCompactionSources } from "../capability-result-compaction-source.js";
import { hasSuperContextContract } from "../super-context-policy.js";
import {
  assertValidSemanticCompactionCheckpoint,
  createSemanticCompactionSha256Fingerprint as hash,
  SEMANTIC_COMPACTION_CONTEXT_LANE,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionCheckpointBinding,
  type SemanticCompactionSource,
} from "./contracts.js";
import type { RequestContextCompactionStore } from "./store.js";
import { assertHistoricalOperationSource } from "./super-operation-source.js";
import { assertHistoricalChildResultSource } from "./super-child-result-source.js";
import { assertHistoricalReviewerSource } from "./super-reviewer-source.js";
import { readStoredSourceMessage } from "./super-source-message.js";

export type SuperCompactionIntegrityInput = Readonly<{
  requestId: string;
  prompt: string;
  head: RoleCallLedgerHead;
  store: RequestContextCompactionStore;
}>;

/** Independently checks stored canonical bytes even when no checkpoint was committed. */
export function assertSuperCompactionSourceIntegrity(
  params: SuperCompactionIntegrityInput,
): void {
  assertSuperIntegrityRequest(params);
  const snapshot = params.store.snapshot?.();
  if (!snapshot) throw new Error("context_compaction_snapshot_unavailable");
  const canonicalSources = new Map<
    string,
    ReadonlyMap<string, SemanticCompactionSource>
  >();
  for (const source of snapshot.sources)
    assertOwnedSource(params, source, canonicalSources);
}

/** Derived checkpoint validation is separate so a candidate failure cannot taint healthy sources. */
export function assertSuperCompactionCheckpointIntegrity(
  params: SuperCompactionIntegrityInput & {
    checkpoint: SemanticCompactionCheckpoint;
  },
): void {
  assertSuperIntegrityRequest(params);
  const { checkpoint, head } = params;
  assertValidSemanticCompactionCheckpoint(checkpoint);
  assertSuperCompactionCheckpointBinding(params);
  const call = head.state.calls.find(
    (candidate) => candidate.callId === checkpoint.callId,
  )!;
  if (checkpoint.sourceRevision > head.revision)
    throw new Error("context_compaction_checkpoint_revision_invalid");
  const canonicalSources = new Map<
    string,
    ReadonlyMap<string, SemanticCompactionSource>
  >();
  for (const digest of checkpoint.sourceDigests) {
    const source = params.store.materializeSource(
      digest.sourceRef,
      digest.sourceFingerprint,
    );
    if (source === undefined)
      throw new CompactionSourceInvariantError(
        "context_compaction_source_materialization_missing",
        digest.sourceRef,
      );
    assertOwnedSource(params, source, canonicalSources, call);
  }
}

/** Exact owned binding, independent of derived continuation content/revision health. */
export function assertSuperCompactionCheckpointBinding(
  params: Omit<SuperCompactionIntegrityInput, "store"> & {
    checkpoint: SemanticCompactionCheckpointBinding & { scopeId: string };
  },
): void {
  const { checkpoint, head, requestId, prompt } = params;
  if (!hasSuperContextContract(head.policy.authority, "supervisor"))
    throw new Error("context_compaction_source_policy_invalid");
  const call = head.state.calls.find(
    (candidate) => candidate.callId === checkpoint.callId,
  );
  if (!call) throw new Error("context_compaction_checkpoint_call_invalid");
  if (head.state.requestId !== requestId || checkpoint.requestId !== requestId)
    throw new Error("context_compaction_checkpoint_request_invalid");
  if (checkpoint.currentRequestFingerprint !== hash(prompt))
    throw new Error("context_compaction_checkpoint_request_invalid");
  if (checkpoint.roleId !== call.roleId)
    throw new Error("context_compaction_checkpoint_role_invalid");
  const objective = call.roleId === "supervisor" ? prompt : call.objective;
  if (!objective || checkpoint.objectiveFingerprint !== hash(objective))
    throw new Error("context_compaction_checkpoint_objective_invalid");
  if (checkpoint.contextLane !== SEMANTIC_COMPACTION_CONTEXT_LANE)
    throw new Error("context_compaction_checkpoint_lane_invalid");
  assertOwnedScopeBinding(checkpoint, call);
}

function assertSuperIntegrityRequest(
  params: SuperCompactionIntegrityInput,
): void {
  if (params.head.state.requestId !== params.requestId)
    throw new Error("context_compaction_source_request_invalid");
  if (!hasSuperContextContract(params.head.policy.authority, "supervisor"))
    throw new Error("context_compaction_source_policy_invalid");
}

function assertOwnedScopeBinding(
  checkpoint: SemanticCompactionCheckpointBinding & { scopeId: string },
  call: RoleCallFrame,
): void {
  const expectedScope =
    call.roleId === "worker"
      ? `worker:${call.callId}:request-tool-results`
      : `role:${call.roleId}:${call.callId}:continuation`;
  if (checkpoint.scopeId !== expectedScope)
    throw new Error("context_compaction_checkpoint_scope_invalid");
  const consumers = resolveOwnedConsumers(call);
  if (JSON.stringify(checkpoint.allowedConsumers) !== JSON.stringify(consumers))
    throw new Error("context_compaction_checkpoint_consumers_invalid");
}

function resolveOwnedConsumers(call: RoleCallFrame): readonly string[] {
  if (call.roleId === "worker")
    return WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS;
  if (call.roleId === "supervisor")
    return ["supervisor.decision", "supervisor.response"];
  if (call.roleId === "planner") return ["planner.decision", "planner.graph"];
  if (call.roleId === "reviewer") return ["reviewer.decision"];
  throw new Error("context_compaction_checkpoint_role_invalid");
}

function assertOwnedSource(
  params: SuperCompactionIntegrityInput,
  source: SemanticCompactionSource,
  canonicalSources: Map<string, ReadonlyMap<string, SemanticCompactionSource>>,
  scopeCall?: RoleCallFrame,
): void {
  if (hash(source.content) !== source.sourceFingerprint)
    throw new CompactionSourceInvariantError(
      "context_compaction_source_content_mismatch",
      source.sourceRef,
    );
  if (
    params.store.materializeSource(source.sourceRef, source.sourceFingerprint)
      ?.content !== source.content
  )
    throw new CompactionSourceInvariantError(
      "context_compaction_source_materialization_missing",
      source.sourceRef,
    );
  const execution = params.head.state.capabilityExecutions.find(
    (candidate) => candidate.executionId === source.sourceRef,
  );
  if (execution) {
    if (scopeCall && scopeCall.callId !== execution.callId)
      throw new CompactionSourceInvariantError(
        "context_compaction_execution_owner_invalid",
        source.sourceRef,
      );
    let ownedSources = canonicalSources.get(execution.callId);
    if (!ownedSources) {
      ownedSources = new Map(
        projectCanonicalCapabilityResultCompactionSources({
          head: params.head,
          callId: execution.callId,
        }).map((candidate) => [candidate.sourceRef, candidate]),
      );
      canonicalSources.set(execution.callId, ownedSources);
    }
    const canonical = ownedSources.get(source.sourceRef);
    if (
      !canonical ||
      canonical.sourceFingerprint !== source.sourceFingerprint ||
      canonical.content !== source.content
    )
      throw new CompactionSourceInvariantError(
        "context_compaction_execution_source_changed",
        source.sourceRef,
      );
    return;
  }
  const message = readStoredSourceMessage(source);
  const record = readSourceCapsuleHeader(message.content);

  if (record.kind === "runtime_operation_supervision_evidence_v1") {
    const call = requireSourceOwner(
      params.head,
      readSourceBindingCallId(record.binding),
      scopeCall,
    );
    assertHistoricalOperationSource({ source, head: params.head, call });
    return;
  }
  if (record.kind === "runtime_child_result") {
    const call = requireSourceOwner(
      params.head,
      record.callerCallId,
      scopeCall,
    );
    assertHistoricalChildResultSource({ source, head: params.head, call });
    return;
  }
  if (record.kind === "runtime_reviewer_evidence_v1") {
    assertOwnedReviewerSource(params, source, scopeCall);
    return;
  }
  throw new CompactionSourceInvariantError(
    "context_compaction_source_family_invalid",
    source.sourceRef,
  );
}

function requireSourceOwner(
  head: RoleCallLedgerHead,
  callId: unknown,
  scopeCall?: RoleCallFrame,
): RoleCallFrame {
  const call = head.state.calls.find(
    (candidate) => candidate.callId === callId,
  );
  if (!call) throw new Error("context_compaction_source_call_invalid");
  if (scopeCall && scopeCall.callId !== call.callId)
    throw new Error("context_compaction_source_call_invalid");
  return call;
}

function assertOwnedReviewerSource(
  params: SuperCompactionIntegrityInput,
  source: SemanticCompactionSource,
  scopeCall?: RoleCallFrame,
): void {
  if (scopeCall) {
    assertHistoricalReviewerSource({ ...params, source, call: scopeCall });
    return;
  }
  const candidates = params.head.state.calls.filter(
    (call) => call.roleId === "reviewer",
  );
  for (const call of candidates) {
    try {
      assertHistoricalReviewerSource({ ...params, source, call });
      return;
    } catch {
      /* Another historical reviewer may own this inventory source. */
    }
  }
  throw new Error("context_compaction_reviewer_source_unowned");
}

function readSourceCapsuleHeader(content: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content.split("\n", 1)[0]!);
  } catch {
    throw new Error("context_compaction_source_family_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("context_compaction_source_family_invalid");
  return value as Record<string, unknown>;
}
function readSourceBindingCallId(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return (value as Record<string, unknown>).callId;
}
