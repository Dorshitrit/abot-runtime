import { SuperContextFailure } from "../context/super-context-failure.js";
import {
  assertSuperCompactionSourceIntegrity,
  assertSuperCompactionCheckpointIntegrity,
  assertSuperCompactionCheckpointBinding,
} from "../context/semantic-compaction/super-source-integrity.js";
import { isCheckpointQuarantineReason } from "../context/semantic-compaction/scope-quarantine.js";
import type { SemanticCompactionCheckpoint } from "../context/semantic-compaction/contracts.js";
import type { SuperCompactionIntegrityInput } from "../context/semantic-compaction/super-source-integrity.js";
import {
  hasCurrentSuperFailureAuthority,
  type SuperContextFailureReturnInput,
} from "./super-context-failure-integrity.js";
import { traceDebug } from "../observability/debug-logger.js";

/** Revalidate stored data independently; the caught projection is never proof. */
export function quarantineProvenUnusableSuperCheckpoint(
  params: SuperContextFailureReturnInput,
): void {
  if (!hasCurrentSuperFailureAuthority(params)) return;
  const failure = params.error as SuperContextFailure;
  const store = params.request.contextCompactionStore;
  if (!store) return;
  const quarantined = quarantineProvenOwnedSuperCheckpoint({
    requestId: params.request.requestId,
    prompt: params.request.prompt,
    head: params.expectedHead,
    store,
    scopeId: failure.binding.scopeId,
  });
  if (quarantined)
    traceDebug("runtime.context.compaction", "checkpoint.quarantined", {
      ...failure.binding,
      code: failure.code,
      validationCode: quarantined,
    });
}

/** Callers establish current or captured canonical invocation ownership first. */
export function quarantineProvenOwnedSuperCheckpoint(
  integrity: SuperCompactionIntegrityInput & { scopeId: string },
): string | undefined {
  const { store } = integrity;
  if (!store.snapshot || !store.quarantineScope) return undefined;
  const checkpoint = store
    .snapshot()
    .checkpoints.find((candidate) => candidate.scopeId === integrity.scopeId);
  if (!checkpoint) return undefined;
  try {
    assertSuperCompactionSourceIntegrity(integrity);
    assertSuperCompactionCheckpointBinding({ ...integrity, checkpoint });
    if (!Array.isArray(checkpoint.sourceDigests)) return;
    for (const digest of checkpoint.sourceDigests) {
      if (!store.materializeSource(digest.sourceRef, digest.sourceFingerprint))
        return;
    }
  } catch {
    return;
  }
  try {
    assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint });
  } catch (validation: unknown) {
    if (!(validation instanceof Error)) return;
    if (!isCheckpointQuarantineReason(validation.message)) return;
    store.quarantineScope({
      scopeId: checkpoint.scopeId,
      binding: checkpointBinding(checkpoint),
      failureCode: validation.message,
    });
    return validation.message;
  }
}

function checkpointBinding(checkpoint: SemanticCompactionCheckpoint) {
  return {
    requestId: checkpoint.requestId,
    currentRequestFingerprint: checkpoint.currentRequestFingerprint,
    roleId: checkpoint.roleId,
    callId: checkpoint.callId,
    objectiveFingerprint: checkpoint.objectiveFingerprint,
    contextLane: checkpoint.contextLane,
    allowedConsumers: checkpoint.allowedConsumers,
  };
}
