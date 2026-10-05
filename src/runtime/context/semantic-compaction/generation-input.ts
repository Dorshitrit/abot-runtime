import type { ChatMessage } from "../../../model-gateway/types.js";
import type {
  SemanticCompactionContinuation,
  SemanticCompactionDigest,
} from "./contracts.js";
import type { SemanticCompactionSourceSlice } from "./chunking.js";
import type { SemanticCompactionGenerationParams } from "./generation-contracts.js";
import { SEMANTIC_COMPACTION_EVIDENCE_SCOPE } from "./evidence-scope.js";
import { SEMANTIC_COMPACTION_INSTRUCTIONS } from "./prompt.js";
import { bindSemanticCompactionSourceSlots } from "./source-slots.js";

export type SemanticCompactionFoldState = Readonly<{
  continuation: SemanticCompactionContinuation;
  sourceDigests: readonly SemanticCompactionDigest[];
  coveredThroughByte: number;
}>;

export function buildSemanticCompactionMessages(
  params: SemanticCompactionGenerationParams,
): ChatMessage[] {
  return [
    Object.freeze({
      role: "system" as const,
      content: SEMANTIC_COMPACTION_INSTRUCTIONS,
    }),
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: "runtime_semantic_compaction_input_v2",
        evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
        currentRequest: params.request.prompt,
        active: projectActiveAssignment(params),
        ...(params.previous
          ? {
              previousContinuation: params.previous.continuation,
              previousSourceDigests: bindSemanticCompactionSourceSlots(
                params.previous.sourceDigests,
              ),
            }
          : {}),
        newSources: bindSemanticCompactionSourceSlots(
          params.sources,
          params.previous?.sourceDigests.length ?? 0,
        ),
      }),
    }),
  ];
}

export function buildSemanticCompactionSliceMessages(
  params: SemanticCompactionGenerationParams,
  slice: SemanticCompactionSourceSlice,
  state: SemanticCompactionFoldState | undefined,
): ChatMessage[] {
  return [
    Object.freeze({
      role: "system" as const,
      content: [
        SEMANTIC_COMPACTION_INSTRUCTIONS,
        "The supplied source is one exact contiguous UTF-8 range of a larger canonical source.",
        "Return all replacement source digests and one replacement continuation. For the sliced source, preserve every previously supplied range plus this range; do not treat ranges as separate sources. partialSourceFold is the latest summary of the covered ranges and replaces the older checkpoint for this generation.",
      ].join("\n"),
    }),
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: "runtime_semantic_compaction_slice_input_v1",
        evidenceScope: SEMANTIC_COMPACTION_EVIDENCE_SCOPE,
        currentRequest: params.request.prompt,
        active: projectActiveAssignment(params),
        ...(params.previous && !state
          ? {
              previousCheckpoint: {
                continuation: params.previous.continuation,
                sourceDigests: bindSemanticCompactionSourceSlots(
                  params.previous.sourceDigests,
                ),
              },
            }
          : {}),
        ...(state
          ? {
              partialSourceFold: {
                coveredThroughByte: state.coveredThroughByte,
                continuation: state.continuation,
                sourceDigests: bindSemanticCompactionSourceSlots(
                  state.sourceDigests,
                ),
              },
            }
          : {}),
        sourceSlice: bindSemanticCompactionSourceSlots(
          [slice],
          params.previous?.sourceDigests.length ?? 0,
        )[0],
      }),
    }),
  ];
}

function projectActiveAssignment(params: SemanticCompactionGenerationParams) {
  return {
    roleId: params.binding.roleId,
    callId: params.binding.callId,
    preservationObjective: params.preservationObjective,
    allowedConsumers: params.binding.allowedConsumers,
  };
}
