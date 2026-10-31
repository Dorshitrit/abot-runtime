import type {
  SemanticCompactionContinuation,
  SemanticCompactionSource,
} from "../semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "../semantic-compaction/generation-contracts.js";
import {
  createSemanticCompactionSourceSlice,
  projectSemanticCompactionUtf8Boundaries,
} from "../semantic-compaction/chunking.js";
import { createSuperCompactionCapsule } from "./capsule.js";
import {
  doesSuperCompactionStageFit,
  invokeSuperContinuationText,
} from "./model-call.js";

export const SUPER_CONTINUATION_MAX_CHARACTERS = 1_000;

export function createSuperContinuation(
  currentState: string,
): SemanticCompactionContinuation {
  return Object.freeze({
    format: "raw_handoff_v1",
    completed: [],
    currentState,
    findings: [],
    evidenceRefs: [],
    artifacts: [],
    decisions: [],
    failedApproaches: [],
    openWork: [],
    blockers: [],
    nextStep:
      "Continue under the active assignment and canonical role state; consult the source digests and their limits.",
  });
}

/** A retained small source needs no lossy writing; only incorporate its handoff. */
export async function continueSuperRetainedSource(
  params: SemanticCompactionGenerationParams,
  source: SemanticCompactionSource,
  previousContinuation: string | undefined,
): Promise<string> {
  const boundaries = projectSemanticCompactionUtf8Boundaries(source.content);
  const sourceSlice = createSemanticCompactionSourceSlice({
    source,
    boundaries,
    startBoundaryIndex: 0,
    endBoundaryIndex: boundaries.length - 1,
  });
  const baseMessages = createSuperCompactionCapsule({
    currentRequest: params.request.prompt,
    sourceSlice,
    previousContinuation,
    assignment: {
      ...params.binding,
      preservationObjective: params.preservationObjective,
    },
  });
  const input = {
    request: params.request,
    baseMessages,
    maxCharacters: SUPER_CONTINUATION_MAX_CHARACTERS,
    boundSteeringVersion: params.boundSteeringVersion,
  };
  const fits = await doesSuperCompactionStageFit({
    ...input,
    stage: "continuation",
  });
  if (!fits)
    throw new Error("super_compaction_continuation_input_exceeds_budget");
  return invokeSuperContinuationText(input);
}
