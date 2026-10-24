import type { ChatMessage } from "../../../model-gateway/types.js";
import type { SemanticCompactionCheckpoint } from "./contracts.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "./evidence-scope.js";

export type CheckpointProjectionOptions = Readonly<{
  includeContinuation?: boolean;
  replacesScopeId?: string;
}>;

export function buildCheckpointMessage(
  checkpoint: SemanticCompactionCheckpoint,
  options: CheckpointProjectionOptions = {},
): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: checkpoint.kind,
      evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
      authority:
        options.includeContinuation === false
          ? "passive_source_evidence"
          : "runtime_role_continuation",
      presenceEffect:
        options.includeContinuation === false
          ? "passive_source_evidence_not_current_intent_or_completion"
          : "passive_continuity_not_user_intent_routing_or_completion",
      scopeId: checkpoint.scopeId,
      roleId: checkpoint.roleId,
      callId: checkpoint.callId,
      sourceRevision: checkpoint.sourceRevision,
      coveredSources: checkpoint.sourceDigests.map(
        ({ sourceRef, sourceFingerprint, digest }) => ({
          sourceRef,
          sourceFingerprint,
          digest,
        }),
      ),
      ...(options.includeContinuation === false
        ? {}
        : { continuation: checkpoint.continuation }),
    }),
  });
}
