import { projectSuperContinuation } from "./continuation-projection.js";
import {
  assertValidSemanticCompactionCheckpoint,
  type SemanticCompactionCandidate,
  type SemanticCompactionDigest,
} from "../semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "../semantic-compaction/generation-contracts.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import {
  prepareSuperCheckpointBudget,
  assertSuperCheckpointFits,
} from "./checkpoint-budget.js";
import {
  continueSuperRetainedSource,
  createSuperContinuation,
  SUPER_CONTINUATION_MAX_CHARACTERS,
} from "./continuation.js";
import { foldSuperCompactionSource } from "./source-fold.js";
import { prepareSuperSourceInventory } from "./source-inventory.js";

/** SUPER authors bounded ranges; the shared controller alone projects and commits. */
export async function generateSuperCompactionCandidate(
  params: SemanticCompactionGenerationParams,
): Promise<SemanticCompactionCandidate> {
  const steering = resolveRequestSteeringInbox(params.request.requestSteering);
  assertBoundModelStepSteeringCurrent(steering, params.boundSteeringVersion);
  const sources = prepareSuperSourceInventory(params);
  const { budget, sourceCharacterLimits } = await prepareSuperCheckpointBudget(
    params,
    sources,
  );
  const sourceDigests: SemanticCompactionDigest[] = [];
  let handoff = params.previous
    ? projectSuperContinuation(params.previous.continuation).text
    : undefined;
  for (const [index, source] of sources.entries()) {
    params.request.abortSignal.throwIfAborted();
    params.onProgress?.({ step: "processing", unit: "sources", completedUnits: index, totalUnits: sources.length });
    const maxCharacters = sourceCharacterLimits[index]!;
    const existing = params.previous?.sourceDigests[index];
    const retainedText =
      existing?.digest ??
      `Retained source (verbatim):\n${source.content}\nEnd of retained source.`;
    if (hasBoundedSourceText(retainedText, maxCharacters)) {
      sourceDigests.push(
        Object.freeze({
          sourceRef: source.sourceRef,
          sourceFingerprint: source.sourceFingerprint,
          digest: retainedText,
        }),
      );
      if (!existing)
        handoff = await continueSuperRetainedSource(params, source, handoff);
      params.onProgress?.({ step: "processing", unit: "sources", completedUnits: index + 1, totalUnits: sources.length });
      continue;
    }
    const folded = await foldSuperCompactionSource({
      request: params.request,
      onProgress: (progress) => params.onProgress?.({
        ...progress, unit: "sources", completedUnits: index, totalUnits: sources.length,
      }),
      currentRequest: params.request.prompt,
      assignment: {
        ...params.binding,
        preservationObjective: params.preservationObjective,
      },
      source,
      maxCharacters,
      boundSteeringVersion: params.boundSteeringVersion,
      previousContinuation: handoff,
      continuationMaxCharacters: SUPER_CONTINUATION_MAX_CHARACTERS,
    });
    params.onProgress?.({ step: "processing", unit: "sources", completedUnits: index + 1, totalUnits: sources.length });
    handoff = folded.continuation;
    const digest = folded.digest;
    sourceDigests.push(
      Object.freeze({
        sourceRef: source.sourceRef,
        sourceFingerprint: source.sourceFingerprint,
        digest,
      }),
    );
  }
  if (!handoff) throw new Error("super_compaction_continuation_empty");
  const continuation = createSuperContinuation(handoff);
  const candidate: SemanticCompactionCandidate = Object.freeze({
    ...params.binding,
    kind: "runtime_semantic_compaction_checkpoint_v2",
    scopeId: params.scopeId,
    sourceRevision: params.sourceRevision,
    sourceDigests: Object.freeze(sourceDigests),
    continuation,
  });
  assertValidSemanticCompactionCheckpoint(candidate);
  await assertSuperCheckpointFits(params, candidate, budget);
  assertBoundModelStepSteeringCurrent(steering, params.boundSteeringVersion);
  return candidate;
}

function hasBoundedSourceText(text: string, maxCharacters: number): boolean {
  if (!text.trim()) return false;
  if (text !== text.trim()) return false;
  return text.length <= maxCharacters;
}
