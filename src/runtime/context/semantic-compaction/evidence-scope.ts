/** Derived presentation metadata; persisted checkpoint bytes remain unchanged. */
export const SEMANTIC_COMPACTION_EVIDENCE_SCOPE = Object.freeze({
  kind: "runtime_semantic_compaction_evidence_scope_v1" as const,
  authority: "passive_reference_only" as const,
  coverage: "listed_source_evidence_only" as const,
  omissionMeaning: "not_supplied_not_proven_absent" as const,
});
