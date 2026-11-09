import type { CompactionProgressObserver } from "../../model/context-compaction-progress.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { BoundRequestModelInvocationContext } from "../../request/contracts.js";
import type { SemanticCompactionSourceSlice } from "../semantic-compaction/chunking.js";
import type { SemanticCompactionSource } from "../semantic-compaction/contracts.js";
import type { SuperCompactionDerivedContext } from "./capsule.js";
import { doesSuperCompactionStageFit, invokeSuperCompactionStageText } from "./model-call.js";

export type SuperCompactionWindowDraft = Readonly<{
  range: SemanticCompactionSourceSlice["range"];
  coverage: string;
  content: string;
  baseMessages: readonly ChatMessage[];
}>;

type MergeNode = Readonly<{
  range: SemanticCompactionSourceSlice["range"];
  text: string;
  baseMessages: readonly ChatMessage[];
  derived: SuperCompactionDerivedContext;
  retainedMerge: boolean;
}>;

type MergeParams = Readonly<{
  request: BoundRequestModelInvocationContext;
  onProgress?: CompactionProgressObserver;
  currentRequest: string;
  assignment: Readonly<Record<string, unknown>>;
  authority?: "prior_conversation" | "settled_evidence";
  source: SemanticCompactionSource;
  previousContinuation?: string;
  maxCharacters: number;
  /** Active SUPER may join intermediate drafts; the final source keeps its writing bound. */
  allowIntermediateJoins?: true;
  continuationMaxCharacters?: number;
  boundSteeringVersion?: number;
  drafts: readonly SuperCompactionWindowDraft[];
}>;

/** Each level combines adjacent pairs; earlier facts are not rewritten for every new window. */
export async function mergeSuperCompactionWindows(params: MergeParams): Promise<
  Readonly<{
    digest: string;
    baseMessages: readonly ChatMessage[];
    derived: SuperCompactionDerivedContext;
  }>
> {
  assertCompleteWindowDraftCoverage(params.source, params.drafts);
  let nodes: readonly MergeNode[] = params.drafts.map((draft) =>
    Object.freeze({
      range: draft.range,
      text: [
        "Inner coverage (derived):",
        draft.coverage,
        "Compact evidence (derived; detail may be omitted):",
        draft.content,
      ].join("\n"),
      baseMessages: draft.baseMessages,
      retainedMerge: false,
      derived: Object.freeze({
        coverage: draft.coverage,
        content: draft.content,
      }),
    }),
  );
  while (nodes.length > 1) {
    const next: MergeNode[] = [];
    for (let index = 0; index < nodes.length; index += 2) {
      params.request.abortSignal.throwIfAborted();
      const left = nodes[index]!;
      const right = nodes[index + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      params.onProgress?.({ step: "merging", completedBytes: params.drafts.at(-1)!.range.endByteExclusive, totalBytes: params.drafts.at(-1)!.range.totalBytes });
      next.push(await mergeAdjacentDrafts(params, left, right));
    }
    nodes = Object.freeze(next);
  }
  const final = nodes[0]!;
  return Object.freeze({
    digest: mergedSourceDigest(final.range, final.text),
    baseMessages: final.baseMessages,
    derived: final.derived,
  });
}

async function mergeAdjacentDrafts(
  params: MergeParams,
  left: MergeNode,
  right: MergeNode,
): Promise<MergeNode> {
  if (!hasAdjacentMergeRanges(left.range, right.range))
    throw new Error("super_compaction_merge_ranges_invalid");
  const range = Object.freeze({
    startByte: left.range.startByte,
    endByteExclusive: right.range.endByteExclusive,
    totalBytes: left.range.totalBytes,
  });
  [left, right] = await prepareMergeChildren(params, left, right);
  const baseMessages = buildMergeBaseMessages(params, left, right, range);
  const joined = joinDrafts(left, right);
  const retained = await canRetainJoinedDrafts(params, range, joined, baseMessages);
  let text = joined;
  if (!retained)
    text = await invokeSuperCompactionStageText({
      request: params.request,
      stage: "merge",
      baseMessages,
      maxCharacters: params.maxCharacters,
      boundSteeringVersion: params.boundSteeringVersion,
    });
  return Object.freeze({
    range,
    text,
    baseMessages,
    derived: Object.freeze({ content: text }),
    retainedMerge: retained && canDeferIntermediateMerge(params, range, joined),
  });
}

function joinDrafts(left: MergeNode, right: MergeNode): string {
  return [left, right].map((node) =>
    `Derived range [${node.range.startByte},${node.range.endByteExclusive})/${node.range.totalBytes}:\n${node.text}`,
  ).join("\n");
}

function buildMergeBaseMessages(
  params: MergeParams,
  left: MergeNode,
  right: MergeNode,
  range: MergeNode["range"] = {
    startByte: left.range.startByte,
    endByteExclusive: right.range.endByteExclusive,
    totalBytes: left.range.totalBytes,
  },
): readonly ChatMessage[] {
  return Object.freeze([
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: "runtime_super_compaction_merge_v1",
        authority: "derived_source_summaries",
        sourceAuthority: params.authority ?? "settled_evidence",
        purpose: "combine_two_adjacent_drafts_for_the_bound_source",
        applicability: "only_the_two_supplied_child_ranges_of_this_source",
        presenceEffect: "no_new_user_intent_actions_routing_or_completion",
        omissionMeaning:
          "drafts_are_lossy_not_original_source_evidence;_unmentioned_is_not_absent",
        currentRequest: params.currentRequest,
        assignment: params.assignment,
        source: {
          sourceRef: params.source.sourceRef,
          sourceFingerprint: params.source.sourceFingerprint,
          range,
        },
        ...(params.previousContinuation === undefined
          ? {}
          : {
              previousContinuation: {
                authority: "derived_handoff_from_previously_supplied_evidence",
                content: params.previousContinuation,
              },
            }),
        children: [left, right].map((node) => ({
          range: node.range,
          authority: "derived_window_summary",
          digest: node.text,
        })),
      }),
    }),
  ]);
}

/** Complete a deferred merge only when the next parent actually needs smaller children. */
async function prepareMergeChildren(
  params: MergeParams,
  left: MergeNode,
  right: MergeNode,
): Promise<[MergeNode, MergeNode]> {
  const children: [MergeNode, MergeNode] = [left, right];
  if (!hasDeferredMerge(children)) return children;
  for (const index of [0, 1] as const) {
    if (await doesMergePipelineInputFit(params, ...children))
      return children;
    const child = children[index];
    if (!child.retainedMerge) continue;
    if (!await doesMergeInputFit(params, child.baseMessages))
      throw new Error("super_compaction_input_exceeds_budget");
    const text = await invokeSuperCompactionStageText({
      request: params.request,
      stage: "merge",
      baseMessages: child.baseMessages,
      maxCharacters: params.maxCharacters,
      boundSteeringVersion: params.boundSteeringVersion,
    });
    children[index] = Object.freeze({
      ...child, text, derived: Object.freeze({ content: text }), retainedMerge: false,
    });
  }
  // Once all deferred children are reduced, the normal parent merge can still
  // shrink their joined text. Only an oversized frozen base makes that futile.
  if (!await doesMergePipelineInputFit(params, ...children, true))
    throw new Error("super_compaction_input_exceeds_budget");
  return children;
}

function hasDeferredMerge(children: readonly MergeNode[]): boolean {
  return children.some((child) => child.retainedMerge);
}

async function doesMergePipelineInputFit(
  params: MergeParams, left: MergeNode, right: MergeNode,
  modelWrittenParent = false,
): Promise<boolean> {
  const baseMessages = buildMergeBaseMessages(params, left, right);
  if (!await doesMergeInputFit(params, baseMessages)) return false;
  if (params.continuationMaxCharacters === undefined) return true;
  // Prepare the frozen base before authoring. Measure the actual join rather
  // than treating a writing target as a hard limit on the next stage's input.
  return doesSuperCompactionStageFit({
    request: params.request, stage: "continuation", baseMessages,
    maxCharacters: params.continuationMaxCharacters,
    derived: { content: modelWrittenParent ? "" : joinDrafts(left, right) },
  });
}

function doesMergeInputFit(params: MergeParams, baseMessages: readonly ChatMessage[]): Promise<boolean> {
  return doesSuperCompactionStageFit({
    request: params.request, stage: "merge", baseMessages, maxCharacters: params.maxCharacters,
  });
}

function mergedSourceDigest(range: MergeNode["range"], text: string): string {
  return `Supplied source bytes: [${range.startByte},${range.endByteExclusive})/${range.totalBytes}.\n${text}`;
}

/** Preserve the final-source writing bound and admit exact intermediate joins by stage input. */
async function canRetainJoinedDrafts(
  params: MergeParams,
  range: MergeNode["range"],
  text: string,
  baseMessages: readonly ChatMessage[],
): Promise<boolean> {
  const digest = mergedSourceDigest(range, text);
  if (digest.length > params.maxCharacters && !canDeferIntermediateMerge(params, range, text))
    return false;
  const input = { request: params.request, baseMessages, maxCharacters: params.maxCharacters };
  if (!await doesSuperCompactionStageFit({ ...input, stage: "merge" })) return false;
  if (params.continuationMaxCharacters === undefined) return true;
  return doesSuperCompactionStageFit({
    ...input,
    stage: "continuation",
    maxCharacters: params.continuationMaxCharacters,
    derived: { content: text },
  });
}

function canDeferIntermediateMerge(
  params: MergeParams, range: MergeNode["range"], text: string,
): boolean {
  if (!params.allowIntermediateJoins) return false;
  if (coversCompleteSource(range)) return false;
  return mergedSourceDigest(range, text).length > params.maxCharacters;
}

function coversCompleteSource(range: MergeNode["range"]): boolean {
  if (range.startByte !== 0) return false;
  return range.endByteExclusive === range.totalBytes;
}

function assertCompleteWindowDraftCoverage(
  source: SemanticCompactionSource,
  drafts: readonly SuperCompactionWindowDraft[],
): void {
  if (drafts.length === 0)
    throw new Error("super_compaction_window_drafts_empty");
  const totalBytes = Buffer.byteLength(source.content, "utf8");
  let nextByte = 0;
  for (const draft of drafts) {
    if (!hasValidDraftRange(draft.range, nextByte, totalBytes))
      throw new Error("super_compaction_window_coverage_invalid");
    nextByte = draft.range.endByteExclusive;
  }
  if (nextByte !== totalBytes)
    throw new Error("super_compaction_window_coverage_incomplete");
}

function hasValidDraftRange(
  range: SemanticCompactionSourceSlice["range"],
  nextByte: number,
  totalBytes: number,
): boolean {
  if (range.startByte !== nextByte) return false;
  if (range.totalBytes !== totalBytes) return false;
  if (!Number.isSafeInteger(range.endByteExclusive)) return false;
  if (range.endByteExclusive <= range.startByte) return false;
  return range.endByteExclusive <= totalBytes;
}

function hasAdjacentMergeRanges(
  left: SemanticCompactionSourceSlice["range"],
  right: SemanticCompactionSourceSlice["range"],
): boolean {
  if (left.totalBytes !== right.totalBytes) return false;
  return left.endByteExclusive === right.startByte;
}
