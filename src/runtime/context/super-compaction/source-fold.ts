import type { BoundRequestModelInvocationContext } from "../../request/contracts.js";
import type { SemanticCompactionSource } from "../semantic-compaction/contracts.js";
import { projectSemanticCompactionUtf8Boundaries } from "../semantic-compaction/chunking.js";
import { invokeSuperCompactionStageText } from "./model-call.js";
import { selectSuperCompactionWindow } from "./windows.js";
import {
  mergeSuperCompactionWindows,
  type SuperCompactionWindowDraft,
} from "./window-merge.js";

export async function foldSuperCompactionSource(params: {
  request: BoundRequestModelInvocationContext;
  currentRequest: string;
  assignment: Readonly<Record<string, unknown>>;
  authority?: "prior_conversation" | "settled_evidence";
  source: SemanticCompactionSource;
  maxCharacters: number;
  boundSteeringVersion?: number;
  previousContinuation?: string;
  continuationMaxCharacters?: number;
}): Promise<Readonly<{ digest: string; continuation?: string }>> {
  const limits = {
    ...resolveSuperFoldLimits(params.maxCharacters),
    continuation: params.continuationMaxCharacters,
  };
  const boundaries = projectSemanticCompactionUtf8Boundaries(
    params.source.content,
  );
  if (boundaries.length < 2) throw new Error("super_compaction_source_empty");
  const drafts: SuperCompactionWindowDraft[] = [];
  let startBoundaryIndex = 0;
  while (startBoundaryIndex < boundaries.length - 1) {
    // Every window starts from canonical input, never the preceding lossy draft.
    const selected = await selectSuperCompactionWindow({
      ...params,
      boundaries,
      startBoundaryIndex,
      limits,
    });
    const invocation = {
      request: params.request,
      baseMessages: selected.baseMessages,
      boundSteeringVersion: params.boundSteeringVersion,
    };
    const coverage = await invokeSuperCompactionStageText({
      ...invocation,
      stage: "coverage",
      maxCharacters: limits.coverage,
    });
    const content = await invokeSuperCompactionStageText({
      ...invocation,
      stage: "content",
      maxCharacters: limits.content,
      derived: { coverage },
    });
    drafts.push(
      Object.freeze({
        range: Object.freeze({
          startByte: boundaries[startBoundaryIndex]!.byteOffset,
          endByteExclusive: boundaries[selected.endBoundaryIndex]!.byteOffset,
          totalBytes: boundaries.at(-1)!.byteOffset,
        }),
        coverage,
        content,
        baseMessages: selected.baseMessages,
      }),
    );
    startBoundaryIndex = selected.endBoundaryIndex;
  }
  const merged = await mergeSuperCompactionWindows({ ...params, drafts });
  if (!hasContinuationAssignment(params.continuationMaxCharacters))
    return Object.freeze({ digest: merged.digest });
  const continuation = await invokeSuperCompactionStageText({
    request: params.request,
    stage: "continuation",
    baseMessages: merged.baseMessages,
    derived: merged.derived,
    maxCharacters: params.continuationMaxCharacters,
    boundSteeringVersion: params.boundSteeringVersion,
  });
  return Object.freeze({ digest: merged.digest, continuation });
}

function resolveSuperFoldLimits(maxCharacters: number) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 256)
    throw new Error("super_compaction_digest_budget_too_small");
  const writable = maxCharacters - 160;
  const coverage = Math.min(400, Math.floor(writable / 4));
  return Object.freeze({ coverage, content: writable - coverage });
}

function hasContinuationAssignment(limit: number | undefined): limit is number {
  return limit !== undefined;
}
