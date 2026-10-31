import type { CompactionProgressObserver } from "../../../model/context-compaction-progress.js";
import type { SessionMemorySettledTurn } from "../../../../sessions/memory/source.js";
import {
  createSemanticCompactionSourceSlice,
  projectSemanticCompactionUtf8Boundaries,
} from "../../semantic-compaction/chunking.js";
import { createSemanticCompactionSha256Fingerprint } from "../../semantic-compaction/contracts.js";
import { selectLargestFittingPrefix } from "./batching.js";
import {
  projectSessionMemoryTurn,
  type SessionMemoryCompactionBatch,
} from "./input.js";

/** Fold every canonical byte through the ordinary history summary admission. */
export async function foldOversizedExecutionHistoryTurn(params: {
  turn: SessionMemorySettledTurn;
  onProgress?: CompactionProgressObserver;
  previousSummary?: string;
  fits: (summary: string | undefined, batch: SessionMemoryCompactionBatch) => Promise<boolean>;
  invoke: (summary: string | undefined, batch: SessionMemoryCompactionBatch) => Promise<string>;
}): Promise<string> {
  const content = JSON.stringify(projectSessionMemoryTurn(params.turn, "execution_agent"));
  const source = {
    sourceRef: `session-turn:${encodeURIComponent(params.turn.assistant.requestId ?? "")}:${encodeURIComponent(params.turn.assistant.id)}`,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  };
  const boundaries = projectSemanticCompactionUtf8Boundaries(content);
  let startBoundaryIndex = 0;
  let summary = params.previousSummary;
  while (startBoundaryIndex < boundaries.length - 1) {
    const batchAt = (endBoundaryIndex: number): SessionMemoryCompactionBatch => ({
      scope: "execution_agent",
      turnFragment: createSemanticCompactionSourceSlice({
        source, boundaries, startBoundaryIndex, endBoundaryIndex,
      }),
    });
    const selected = await selectLargestFittingPrefix({
      entries: boundaries.slice(startBoundaryIndex + 1),
      fits: (candidate) => params.fits(summary, batchAt(startBoundaryIndex + candidate.length)),
    });
    const hasFittingHistoryFragment = selected.length > 0;
    if (!hasFittingHistoryFragment)
      throw new Error("session_memory_compaction_fragment_exceeds_budget");
    const endBoundaryIndex = startBoundaryIndex + selected.length;
    params.onProgress?.({ step: "processing", completedBytes: boundaries[startBoundaryIndex]!.byteOffset, totalBytes: boundaries.at(-1)!.byteOffset });
    summary = await params.invoke(summary, batchAt(endBoundaryIndex));
    params.onProgress?.({ step: "processing", completedBytes: boundaries[endBoundaryIndex]!.byteOffset, totalBytes: boundaries.at(-1)!.byteOffset });
    startBoundaryIndex = endBoundaryIndex;
  }
  return summary!;
}
