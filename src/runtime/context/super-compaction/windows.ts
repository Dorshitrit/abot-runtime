import type { ChatMessage } from "../../../model-gateway/types.js";
import type { BoundRequestModelInvocationContext } from "../../request/contracts.js";
import { createSemanticCompactionSourceSlice } from "../semantic-compaction/chunking.js";
import type { SemanticCompactionSource } from "../semantic-compaction/contracts.js";
import type { SemanticCompactionUtf8Boundary } from "../semantic-compaction/chunking.js";
import { createSuperCompactionCapsule } from "./capsule.js";
import { doesSuperCompactionPipelineFit } from "./model-call.js";

// Bound authoring work even when a much larger source fits the input window.
export const SUPER_COMPACTION_WINDOW_BYTES = 4_096;

export async function selectSuperCompactionWindow(params: {
  request: BoundRequestModelInvocationContext;
  currentRequest: string;
  assignment: Readonly<Record<string, unknown>>;
  authority?: "prior_conversation" | "settled_evidence";
  source: SemanticCompactionSource;
  boundaries: readonly SemanticCompactionUtf8Boundary[];
  startBoundaryIndex: number;
  previousContinuation?: string;
  limits: Readonly<{
    coverage: number;
    content: number;
    continuation?: number;
  }>;
}): Promise<
  Readonly<{ endBoundaryIndex: number; baseMessages: readonly ChatMessage[] }>
> {
  const startByte = params.boundaries[params.startBoundaryIndex]!.byteOffset;
  let low = params.startBoundaryIndex + 1;
  let high = low;
  while (
    high < params.boundaries.length &&
    isWithinSourceWorkWindow(params.boundaries[high]!.byteOffset, startByte)
  )
    high += 1;
  high -= 1;
  const maximum = await admitWindow(high);
  if (maximum) return maximum;
  high -= 1;
  let selected:
    | Readonly<{
        endBoundaryIndex: number;
        baseMessages: readonly ChatMessage[];
      }>
    | undefined;
  while (low <= high) {
    params.request.abortSignal.throwIfAborted();
    const endBoundaryIndex = Math.floor((low + high) / 2);
    const candidate = await admitWindow(endBoundaryIndex);
    if (!candidate) {
      high = endBoundaryIndex - 1;
      continue;
    }
    selected = candidate;
    low = endBoundaryIndex + 1;
  }
  if (!selected) throw new Error("super_compaction_input_exceeds_budget");
  return selected;

  async function admitWindow(endBoundaryIndex: number) {
    params.request.abortSignal.throwIfAborted();
    const sourceSlice = createSemanticCompactionSourceSlice({
      source: params.source,
      boundaries: params.boundaries,
      startBoundaryIndex: params.startBoundaryIndex,
      endBoundaryIndex,
    });
    const baseMessages = createSuperCompactionCapsule({
      currentRequest: params.currentRequest,
      assignment: params.assignment,
      authority: params.authority,
      sourceSlice,
      previousContinuation: params.previousContinuation,
    });
    const fits = await doesSuperCompactionPipelineFit({
      request: params.request,
      baseMessages,
      limits: params.limits,
    });
    if (!fits) return undefined;
    return Object.freeze({ endBoundaryIndex, baseMessages });
  }
}

function isWithinSourceWorkWindow(endByte: number, startByte: number): boolean {
  return endByte - startByte <= SUPER_COMPACTION_WINDOW_BYTES;
}
