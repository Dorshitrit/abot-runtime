import {
  assertValidSemanticCompactionCheckpoint,
  sameSemanticCompactionCheckpointBinding,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionCheckpointBinding,
} from "./semantic-compaction/contracts.js";
import type { RequestContextCompactionStore } from "./semantic-compaction/store.js";

type CompactionInheritance = Readonly<{
  checkpoint?: SemanticCompactionCheckpoint;
  store: RequestContextCompactionStore;
  binding: SemanticCompactionCheckpointBinding;
  scopeId: string;
  sourceRevision: number;
}>;

/** The EA owner proves accepted steering lineage; the shared controller enforces isolation. */
export function readInheritedCompactionCheckpoint({
  checkpoint,
  store,
  binding,
  scopeId,
  sourceRevision,
}: CompactionInheritance): SemanticCompactionCheckpoint | undefined {
  if (!checkpoint) return undefined;
  assertValidSemanticCompactionCheckpoint(checkpoint);
  if (!hasExecutionOnlyBinding(binding))
    throw new Error("context_compaction_inheritance_consumer_invalid");
  if (checkpoint.scopeId === scopeId)
    throw new Error("context_compaction_inheritance_scope_invalid");
  if (store.get(checkpoint.scopeId) !== checkpoint)
    throw new Error("context_compaction_inheritance_checkpoint_missing");
  if (checkpoint.sourceRevision > sourceRevision)
    throw new Error("context_compaction_inheritance_revision_invalid");
  if (!sameEvidenceBinding(checkpoint, binding))
    throw new Error("context_compaction_inheritance_binding_invalid");
  return checkpoint;
}

function hasExecutionOnlyBinding(binding: SemanticCompactionCheckpointBinding): boolean {
  if (binding.roleId !== "supervisor") return false;
  if (binding.allowedConsumers.length === 0) return false;
  return binding.allowedConsumers.every(
    (consumer) => consumer === "execution.decision" || consumer === "execution.response",
  );
}

function sameEvidenceBinding(
  checkpoint: SemanticCompactionCheckpoint,
  binding: SemanticCompactionCheckpointBinding,
): boolean {
  return sameSemanticCompactionCheckpointBinding(
    checkpoint,
    { ...binding, objectiveFingerprint: checkpoint.objectiveFingerprint },
  );
}
