import {
  assertValidSemanticCompactionCheckpointBinding,
  type SemanticCompactionCheckpointBinding,
} from "./contracts.js";

export const QUARANTINE_VALIDATION_CODES = [
  "context_compaction_checkpoint_revision_invalid",
  "context_compaction_checkpoint_content_invalid",
  "context_compaction_checkpoint_source_invalid",
  "context_compaction_checkpoint_invalid",
] as const;
export type CheckpointQuarantineReason =
  (typeof QUARANTINE_VALIDATION_CODES)[number];
export type InvalidatedCompactionScope = Readonly<{
  scopeId: string;
  binding: SemanticCompactionCheckpointBinding;
  failureCode: CheckpointQuarantineReason;
}>;

/** The owning validator must prove intact sources and a bad committed derivative. */
export function freezeCompactionInvalidation(
  record: InvalidatedCompactionScope,
): InvalidatedCompactionScope {
  if (!record || typeof record.scopeId !== "string")
    throw new Error("context_compaction_invalidation_invalid");
  if (!record.scopeId.trim() || record.scopeId.length > 512)
    throw new Error("context_compaction_invalidation_invalid");
  if (!isCheckpointQuarantineReason(record.failureCode))
    throw new Error("context_compaction_invalidation_reason_invalid");
  assertValidSemanticCompactionCheckpointBinding(record.binding);
  return Object.freeze({
    scopeId: record.scopeId,
    failureCode: record.failureCode,
    binding: Object.freeze({
      ...record.binding,
      allowedConsumers: Object.freeze([...record.binding.allowedConsumers]),
    }),
  });
}

export function isCheckpointQuarantineReason(
  value: unknown,
): value is CheckpointQuarantineReason {
  return QUARANTINE_VALIDATION_CODES.some((code) => code === value);
}

/** Lower-level record; the consuming invocation supplies typed role provenance. */
export class InvalidatedCompactionScopeError extends Error {
  readonly code = "context_compaction_scope_invalidated";
  constructor(readonly record: InvalidatedCompactionScope) {
    super("context_compaction_scope_invalidated");
  }
}
