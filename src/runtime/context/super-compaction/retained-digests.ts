import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import { projectCompactionSourceInput } from "../compaction-source-input.js";
import {
  assertValidSemanticCompactionCheckpoint,
  type SemanticCompactionCandidate,
  type SemanticCompactionSource,
} from "../semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "../semantic-compaction/generation-contracts.js";
import { doesSuperCheckpointFit, type prepareSuperCheckpointBudget } from "./checkpoint-budget.js";
import { projectSuperContinuation } from "./continuation-projection.js";
import { foldSuperCompactionSource } from "./source-fold.js";

type CheckpointBudget = Awaited<ReturnType<typeof prepareSuperCheckpointBudget>>["budget"];

/** Reduce old evidence only when the actual old/new checkpoint needs its space. */
export async function fitSuperRetainedDigests(
  params: SemanticCompactionGenerationParams,
  candidate: SemanticCompactionCandidate,
  sources: readonly SemanticCompactionSource[],
  sourceCharacterLimits: readonly number[],
  budget: CheckpointBudget,
): Promise<SemanticCompactionCandidate> {
  let checkpointFits = await doesSuperCheckpointFit(params, candidate, budget);
  if (checkpointFits && await canRetainConsumerProjection(params, candidate))
    return candidate;
  const steering = resolveRequestSteeringInbox(params.request.requestSteering);
  let replacement = candidate;
  for (const [index, existing] of (params.previous?.sourceDigests ?? []).entries()) {
    const maxCharacters = sourceCharacterLimits[index]!;
    // The inventory already validates each prior digest's text and canonical identity.
    if (!exceedsRetainedDigestWritingTarget(existing.digest, maxCharacters)) continue;
    params.request.abortSignal.throwIfAborted();
    assertBoundModelStepSteeringCurrent(steering, params.boundSteeringVersion);
    const source = sources[index]!;
    const folded = await foldSuperCompactionSource({
      request: params.request,
      onProgress: (progress) => params.onProgress?.({
        ...progress, unit: "sources", completedUnits: sources.length, totalUnits: sources.length,
      }),
      currentRequest: params.request.prompt,
      assignment: {
        ...params.binding,
        preservationObjective: params.preservationObjective,
      },
      source: projectCompactionSourceInput(source),
      maxCharacters,
      allowIntermediateJoins: true,
      boundSteeringVersion: params.boundSteeringVersion,
      previousContinuation: projectSuperContinuation(params.previous!.continuation).text,
      // The already-authored handoff includes newer outcomes. Never replay an older
      // source into it or author the fresh sources again while reducing this digest.
    });
    params.request.abortSignal.throwIfAborted();
    assertBoundModelStepSteeringCurrent(steering, params.boundSteeringVersion);
    const sourceDigests = [...replacement.sourceDigests];
    sourceDigests[index] = Object.freeze({
      sourceRef: source.sourceRef,
      sourceFingerprint: source.sourceFingerprint,
      digest: folded.digest,
    });
    replacement = Object.freeze({
      ...replacement,
      sourceDigests: Object.freeze(sourceDigests),
    });
    assertValidSemanticCompactionCheckpoint(replacement);
    checkpointFits = await doesSuperCheckpointFit(params, replacement, budget);
    if (checkpointFits && await canRetainConsumerProjection(params, replacement))
      return replacement;
  }
  // The consumer owns the original full-envelope rejection and its error code.
  if (checkpointFits) return replacement;
  throw new Error("context_compaction_checkpoint_tokens_exceeded");
}

function exceedsRetainedDigestWritingTarget(
  digest: string,
  maxCharacters: number,
): boolean {
  return digest.length > maxCharacters;
}

async function canRetainConsumerProjection(
  params: SemanticCompactionGenerationParams,
  candidate: SemanticCompactionCandidate,
): Promise<boolean> {
  if (!params.previous || !params.canRetainCandidate) return true;
  const fits = await params.canRetainCandidate(candidate);
  params.request.abortSignal.throwIfAborted();
  return fits;
}
