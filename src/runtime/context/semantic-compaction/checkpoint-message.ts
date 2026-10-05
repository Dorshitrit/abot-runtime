import type { ChatMessage } from "../../../model-gateway/types.js";
import type { SemanticCompactionCheckpoint } from "./contracts.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "./evidence-scope.js";

export function buildCheckpointMessage(
  checkpoint: SemanticCompactionCheckpoint,
): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: checkpoint.kind,
      evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
      authority: "runtime_role_continuation",
      presenceEffect:
        "passive_continuity_not_user_intent_routing_or_completion",
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
      continuation: checkpoint.continuation,
    }),
  });
}
