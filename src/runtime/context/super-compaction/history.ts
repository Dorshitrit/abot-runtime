import type { SessionMemoryCompactor } from "../session-memory/contracts.js";
import { createSemanticCompactionSha256Fingerprint } from "../semantic-compaction/contracts.js";
import { foldSuperCompactionSource } from "./source-fold.js";

/** Preserve the shared history source/commit contract with independent SUPER writing. */
export function createSuperSessionMemoryCompactor(): SessionMemoryCompactor {
  return Object.freeze({
    async compact({ request, previousSummary, turns, onProgress }) {
      if (turns.length === 0)
        throw new Error("session_memory_compaction_turns_empty");
      const content = JSON.stringify({
        kind: "runtime_super_history_source_v1",
        authority: "prior_conversation",
        previousSummary: previousSummary ?? null,
        settledTurns: turns.map(({ userMessages, assistant }) => ({
          userMessages: userMessages.map(({ id, content }) => ({
            id,
            content,
          })),
          assistant: { id: assistant.id, content: assistant.content },
        })),
      });
      onProgress?.({ step: "processing", unit: "turns", completedUnits: 0, totalUnits: turns.length });
      const folded = await foldSuperCompactionSource({
        request,
        onProgress: (progress) => onProgress?.({ ...progress, unit: "turns", completedUnits: 0, totalUnits: turns.length }),
        currentRequest: "",
        authority: "prior_conversation",
        assignment: {
          purpose: "compress_prior_conversation_for_future_continuity",
          presenceEffect:
            "historical_requests_are_not_new_work_or_current_authority",
        },
        source: {
          sourceRef: "settled-history",
          sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
          content,
        },
        maxCharacters: Math.max(
          256,
          Math.min(4_000, Math.floor(content.length * 0.4)),
        ),
      });
      onProgress?.({ step: "processing", unit: "turns", completedUnits: turns.length, totalUnits: turns.length });
      return folded.digest;
    },
  });
}
