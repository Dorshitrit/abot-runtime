import {
  assessSemanticCompactionMessages,
  assessSemanticCompactionMessagesForAdmission,
} from "./generation-admission.js";
import type {
  SemanticCompactionGenerationParams,
} from "./generation-contracts.js";
import {
  assertInheritedCompactionSourceDigests,
  projectCompactionBatchParams,
  resolvePriorCompactionSourceDigests,
} from "./inherited-source-digests.js";
import { registerSemanticCompactionSources } from "./generation-source-registration.js";
import {
  resolveRequestBudgetInputTokens,
} from "../request-context-budget.js";
import { invokeStructuredModelStep } from "../../model/invoke-structured-step.js";
import { ModelOutputIncompleteError } from "../../model/provider-completion.js";
import { traceDebug } from "../../observability/debug-logger.js";
import {
  CONTEXT_COMPACTION_MODEL_STEP,
  assertValidSemanticCompactionCheckpoint,
  assertValidSemanticCompactionCheckpointBinding,
  createSemanticCompactionSha256Fingerprint,
  sameSemanticCompactionCheckpointBinding,
  semanticCompactionDigestTotalLength,
  type SemanticCompactionCandidate,
  type SemanticCompactionCheckpoint,
  type SemanticCompactionCheckpointBinding,
  type SemanticCompactionContinuation,
  type SemanticCompactionDigest,
  type SemanticCompactionSource,
} from "./contracts.js";
import {
  createSemanticCompactionSourceSlice,
  projectSemanticCompactionUtf8Boundaries,
  type SemanticCompactionSourceSlice,
} from "./chunking.js";
import {
  createSemanticCompactionFormat,
  SEMANTIC_COMPACTION_BATCH_SOURCE_MAX_COUNT,
} from "./format.js";
import { validateSemanticCompactionOutput } from "./output-validation.js";
import { prepareReplacementCompactionBudget } from "./replacement-budget.js";
import {
  buildSemanticCompactionMessages,
  buildSemanticCompactionSliceMessages,
  type SemanticCompactionFoldState,
} from "./generation-input.js";
import {
  SEMANTIC_COMPACTION_BATCH_VALIDATION,
  SEMANTIC_COMPACTION_SLICE_VALIDATION,
  assessSemanticCompactionRepairHeadroom,
} from "./repair-headroom.js";

export type {
  SemanticCompactionGenerationParams,
  SemanticCompactionRequest,
} from "./generation-contracts.js";

export function assessSemanticCompactionInput(
  params: SemanticCompactionGenerationParams,
) {
  return prepareSemanticCompactionInput(params).assessment;
}

async function assessSemanticCompactionInputForAdmission(
  params: SemanticCompactionGenerationParams,
) {
  return (await prepareSemanticCompactionInputForAdmission(params))
    .repairHeadroom;
}

export async function generateSemanticCompactionCandidate(
  params: SemanticCompactionGenerationParams,
): Promise<SemanticCompactionCandidate> {
  const prepared = await prepareSemanticCompactionInputForAdmission(params);
  if (!prepared.repairHeadroom.fits) {
    traceDebug("runtime.context.compaction", "model.input_rejected", {
      requestId: params.request.requestId,
      modelStep: CONTEXT_COMPACTION_MODEL_STEP,
      scopeId: params.scopeId,
      sourceRevision: params.sourceRevision,
      newSourceCount: params.sources.length,
      estimatedInputTokens: prepared.assessment.budget.estimatedInputTokens,
      inputTokens: resolveRequestBudgetInputTokens(prepared.assessment.budget),
      availableInputTokens: prepared.assessment.budget.availableInputTokens,
      repairReserveTokens: prepared.repairHeadroom.repairReserveTokens,
      issueCode: "context_compaction_input_exceeds_budget",
    });
    throw new Error("context_compaction_input_exceeds_budget");
  }
  registerSemanticCompactionSources(params);
  const startedAt = Date.now();
  traceDebug("runtime.context.compaction", "model.started", {
    requestId: params.request.requestId,
    modelStep: CONTEXT_COMPACTION_MODEL_STEP,
    scopeId: params.scopeId,
    sourceRevision: params.sourceRevision,
    previousCoveredSourceCount: resolvePriorCompactionSourceDigests(params).length,
    newSourceCount: params.sources.length,
    inputCharacterCount: prepared.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
  });

  try {
    const generated = await invokeStructuredModelStep<
      Readonly<{
        continuation: SemanticCompactionContinuation;
        sourceDigests: readonly SemanticCompactionDigest[];
      }>
    >({
      request: params.request,
      modelStep: CONTEXT_COMPACTION_MODEL_STEP,
      boundSteeringVersion: params.boundSteeringVersion,
      messages: prepared.messages,
      format: prepared.format,
      configuredInstructionPolicy: params.projectionRepair ? "omit" : undefined,
      timeoutReason: "context_compaction_timeout",
      invalidOutputReason: "invalid_context_compaction_output",
      parse: (text, abortSignal) =>
        validateSemanticCompactionOutput(
          text,
          params,
          prepared.checkpointBudget,
          SEMANTIC_COMPACTION_BATCH_VALIDATION,
          abortSignal,
        ),
    });
    const candidate = Object.freeze({
      kind: "runtime_semantic_compaction_checkpoint_v2" as const,
      scopeId: params.scopeId,
      ...params.binding,
      sourceRevision: params.sourceRevision,
      sourceDigests: generated.sourceDigests,
      continuation: generated.continuation,
    });
    assertValidSemanticCompactionCheckpoint(candidate);
    traceDebug("runtime.context.compaction", "model.completed", {
      requestId: params.request.requestId,
      modelStep: CONTEXT_COMPACTION_MODEL_STEP,
      scopeId: params.scopeId,
      sourceRevision: params.sourceRevision,
      coveredSourceCount: candidate.sourceDigests.length,
      replacementCheckpoint: true,
      digestMode: "rolling_replacement",
      previousDigestCharacters: semanticCompactionDigestTotalLength(
        resolvePriorCompactionSourceDigests(params),
      ),
      replacementDigestCharacters: semanticCompactionDigestTotalLength(
        candidate.sourceDigests,
      ),
      durationMs: Date.now() - startedAt,
    });
    return candidate;
  } catch (error: unknown) {
    traceDebug("runtime.context.compaction", "model.failed", {
      requestId: params.request.requestId,
      modelStep: CONTEXT_COMPACTION_MODEL_STEP,
      scopeId: params.scopeId,
      sourceRevision: params.sourceRevision,
      errorType: error instanceof Error ? error.name : typeof error,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/**
 * Folds canonical sources in deterministic order. A source that cannot fit as
 * one compactor input is folded across contiguous UTF-8 ranges, while the
 * returned checkpoint still contains exactly one digest for the full source.
 */
export async function generateSemanticCompactionCandidateBatched(
  params: SemanticCompactionGenerationParams,
): Promise<SemanticCompactionCandidate> {
  assertInheritedCompactionSourceDigests(params);
  registerSemanticCompactionSources(params);
  let candidate = params.previous;
  let nextSourceIndex = 0;
  while (nextSourceIndex < params.sources.length) {
    let selectedParams: SemanticCompactionGenerationParams | undefined;
    for (
      let endSourceIndex = Math.min(
        params.sources.length,
        nextSourceIndex + SEMANTIC_COMPACTION_BATCH_SOURCE_MAX_COUNT,
      );
      endSourceIndex > nextSourceIndex;
      endSourceIndex -= 1
    ) {
      const batch = Object.freeze(
        params.sources.slice(nextSourceIndex, endSourceIndex),
      );
      const batchParams = projectCompactionBatchParams(params, candidate, batch);
      if ((await assessSemanticCompactionInputForAdmission(batchParams)).fits) {
        selectedParams = batchParams;
        break;
      }
    }
    if (selectedParams) {
      candidate = await generateSemanticCompactionCandidate(selectedParams);
      nextSourceIndex += selectedParams.sources.length;
      continue;
    }
    const source = params.sources[nextSourceIndex]!;
    const slicedParams = projectCompactionBatchParams(
      params, candidate, Object.freeze([source]),
    );
    candidate = await generateSemanticCompactionSlicedSource(
      slicedParams,
      source,
    );
    nextSourceIndex += 1;
  }
  if (!candidate) {
    throw new Error("context_compaction_sources_empty");
  }
  return candidate;
}

async function generateSemanticCompactionSlicedSource(
  params: SemanticCompactionGenerationParams,
  source: SemanticCompactionSource,
): Promise<SemanticCompactionCandidate> {
  const boundaries = projectSemanticCompactionUtf8Boundaries(source.content);
  if (boundaries.length < 2) {
    throw new Error("context_compaction_source_slice_empty");
  }
  let startBoundaryIndex = 0;
  let state: SemanticCompactionFoldState | undefined;
  let outputIncompleteRetryEndBoundaryIndex: number | undefined;
  while (startBoundaryIndex < boundaries.length - 1) {
    let low = startBoundaryIndex + 1;
    let high = outputIncompleteRetryEndBoundaryIndex ?? boundaries.length - 1;
    let selected:
      | Readonly<{
          endBoundaryIndex: number;
          slice: SemanticCompactionSourceSlice;
          prepared: Awaited<
            ReturnType<typeof prepareSemanticCompactionSliceInputForAdmission>
          >;
        }>
      | undefined;
    while (low <= high) {
      const endBoundaryIndex = Math.floor((low + high) / 2);
      const slice = createSemanticCompactionSourceSlice({
        source,
        boundaries,
        startBoundaryIndex,
        endBoundaryIndex,
      });
      const prepared = await prepareSemanticCompactionSliceInputForAdmission(
        params,
        slice,
        state,
      );
      if (prepared.repairHeadroom.fits) {
        selected = Object.freeze({ endBoundaryIndex, slice, prepared });
        low = endBoundaryIndex + 1;
      } else {
        high = endBoundaryIndex - 1;
      }
    }
    if (!selected) {
      throw new Error("context_compaction_source_slice_exceeds_budget");
    }
    let generated: Awaited<ReturnType<typeof invokeSemanticCompactionSlice>>;
    try {
      generated = await invokeSemanticCompactionSlice(
        params,
        selected.prepared,
      );
    } catch (error: unknown) {
      const retryEndBoundaryIndex = resolveOutputIncompleteRetryEndBoundary({
        error,
        startBoundaryIndex,
        selectedEndBoundaryIndex: selected.endBoundaryIndex,
        retryAlreadySelected:
          outputIncompleteRetryEndBoundaryIndex !== undefined,
      });
      if (retryEndBoundaryIndex === undefined) throw error;
      traceDebug("runtime.context.compaction", "source_slice.repartitioned", {
        requestId: params.request.requestId,
        modelStep: CONTEXT_COMPACTION_MODEL_STEP,
        scopeId: params.scopeId,
        sourceRef: source.sourceRef,
        reason: "output_incomplete",
        previousStartByte: selected.slice.range.startByte,
        previousEndByteExclusive: selected.slice.range.endByteExclusive,
        retryEndByteExclusive: boundaries[retryEndBoundaryIndex]!.byteOffset,
      });
      outputIncompleteRetryEndBoundaryIndex = retryEndBoundaryIndex;
      continue;
    }
    state = Object.freeze({
      continuation: generated.continuation,
      sourceDigests: generated.sourceDigests,
      coveredThroughByte: selected.slice.range.endByteExclusive,
    });
    startBoundaryIndex = selected.endBoundaryIndex;
    outputIncompleteRetryEndBoundaryIndex = undefined;
  }
  const totalBytes = boundaries.at(-1)!.byteOffset;
  if (!state || state.coveredThroughByte !== totalBytes) {
    throw new Error("context_compaction_source_slice_coverage_incomplete");
  }
  const candidate = Object.freeze({
    kind: "runtime_semantic_compaction_checkpoint_v2" as const,
    scopeId: params.scopeId,
    ...params.binding,
    sourceRevision: params.sourceRevision,
    sourceDigests: state.sourceDigests,
    continuation: state.continuation,
  });
  assertValidSemanticCompactionCheckpoint(candidate);
  return candidate;
}

function resolveOutputIncompleteRetryEndBoundary(params: {
  error: unknown;
  startBoundaryIndex: number;
  selectedEndBoundaryIndex: number;
  retryAlreadySelected: boolean;
}): number | undefined {
  if (
    !(params.error instanceof ModelOutputIncompleteError) ||
    params.retryAlreadySelected
  ) {
    return undefined;
  }
  const selectedBoundaryCount =
    params.selectedEndBoundaryIndex - params.startBoundaryIndex;
  return selectedBoundaryCount > 1
    ? params.startBoundaryIndex + Math.floor(selectedBoundaryCount / 2)
    : undefined;
}

function prepareSemanticCompactionSliceInput(
  params: SemanticCompactionGenerationParams,
  slice: SemanticCompactionSourceSlice,
  state: SemanticCompactionFoldState | undefined,
) {
  const checkpointBudget = prepareReplacementCompactionBudget(params, [slice]);
  const { expectedSources, checkpointTokenAllowance } = checkpointBudget;
  const format = createSemanticCompactionFormat(
    expectedSources,
    checkpointTokenAllowance,
    params.projectionRepair ? "omit" : undefined,
  );
  const messages = buildSemanticCompactionSliceMessages(params, slice, state);
  const assessment = assessSemanticCompactionMessages(
    params.request,
    messages,
    format,
    params.projectionRepair ? "omit" : undefined,
  );
  return Object.freeze({
    messages,
    format,
    checkpointBudget,
    assessment,
  });
}

async function prepareSemanticCompactionSliceInputForAdmission(
  params: SemanticCompactionGenerationParams,
  slice: SemanticCompactionSourceSlice,
  state: SemanticCompactionFoldState | undefined,
) {
  const prepared = prepareSemanticCompactionSliceInput(params, slice, state);
  const admission = await assessSemanticCompactionMessagesForAdmission(
    params.request,
    prepared.messages,
    prepared.format,
    params.boundSteeringVersion,
    params.projectionRepair ? "omit" : undefined,
  );
  const repairHeadroom = assessSemanticCompactionRepairHeadroom({
    assessment: admission.assessment,
    validation: SEMANTIC_COMPACTION_SLICE_VALIDATION,
    ...(admission.tokenEstimation !== undefined
      ? { tokenEstimation: admission.tokenEstimation }
      : {}),
  });
  return Object.freeze({
    ...prepared,
    assessment: admission.assessment,
    repairHeadroom,
  });
}

async function invokeSemanticCompactionSlice(
  params: SemanticCompactionGenerationParams,
  prepared: Awaited<
    ReturnType<typeof prepareSemanticCompactionSliceInputForAdmission>
  >,
): Promise<
  Readonly<{
    continuation: SemanticCompactionContinuation;
    sourceDigests: readonly SemanticCompactionDigest[];
  }>
> {
  return invokeStructuredModelStep({
    request: params.request,
    modelStep: CONTEXT_COMPACTION_MODEL_STEP,
    boundSteeringVersion: params.boundSteeringVersion,
    messages: prepared.messages,
    format: prepared.format,
    configuredInstructionPolicy: params.projectionRepair ? "omit" : undefined,
    timeoutReason: "context_compaction_timeout",
    invalidOutputReason: "invalid_context_compaction_output",
    parse: (text, abortSignal) =>
      validateSemanticCompactionOutput(
        text,
        params,
        prepared.checkpointBudget,
        SEMANTIC_COMPACTION_SLICE_VALIDATION,
        abortSignal,
      ),
  });
}

function prepareSemanticCompactionInput(
  params: SemanticCompactionGenerationParams,
) {
  assertValidSemanticCompactionCheckpointBinding(params.binding);
  if (
    params.binding.requestId !== params.request.requestId ||
    createSemanticCompactionSha256Fingerprint(params.request.prompt) !==
      params.binding.currentRequestFingerprint ||
    createSemanticCompactionSha256Fingerprint(params.preservationObjective) !==
      params.binding.objectiveFingerprint ||
    !params.scopeId.trim() ||
    !Number.isSafeInteger(params.sourceRevision) ||
    params.sourceRevision < 0 ||
    params.sources.length === 0
  ) {
    throw new Error("context_compaction_input_binding_invalid");
  }
  const sourceRefs = params.sources.map(({ sourceRef }) => sourceRef);
  if (
    new Set(sourceRefs).size !== sourceRefs.length ||
    params.sources.some(
      (source) =>
        source.content.length === 0 ||
        createSemanticCompactionSha256Fingerprint(source.content) !==
          source.sourceFingerprint,
    )
  ) {
    throw new Error("context_compaction_source_refs_invalid");
  }
  if (params.previous) {
    assertValidSemanticCompactionCheckpoint(params.previous);
    if (
      params.previous.scopeId !== params.scopeId ||
      !sameSemanticCompactionCheckpointBinding(
        params.previous,
        params.binding,
      ) ||
      params.previous.sourceRevision > params.sourceRevision ||
      params.previous.sourceDigests.some(({ sourceRef }) =>
        sourceRefs.includes(sourceRef),
      )
    ) {
      throw new Error("context_compaction_checkpoint_not_applicable");
    }
  }
  const checkpointBudget = prepareReplacementCompactionBudget(params);
  const { expectedSources, checkpointTokenAllowance } = checkpointBudget;
  const messages = buildSemanticCompactionMessages(params);
  const format = createSemanticCompactionFormat(
    expectedSources,
    checkpointTokenAllowance,
    params.projectionRepair ? "omit" : undefined,
  );
  const assessment = assessSemanticCompactionMessages(
    params.request,
    messages,
    format,
    params.projectionRepair ? "omit" : undefined,
  );
  return Object.freeze({
    messages,
    format,
    checkpointBudget,
    assessment,
  });
}

async function prepareSemanticCompactionInputForAdmission(
  params: SemanticCompactionGenerationParams,
) {
  const prepared = prepareSemanticCompactionInput(params);
  const admission = await assessSemanticCompactionMessagesForAdmission(
    params.request,
    prepared.messages,
    prepared.format,
    params.boundSteeringVersion,
    params.projectionRepair ? "omit" : undefined,
  );
  const repairHeadroom = assessSemanticCompactionRepairHeadroom({
    assessment: admission.assessment,
    validation: SEMANTIC_COMPACTION_BATCH_VALIDATION,
    ...(admission.tokenEstimation !== undefined
      ? { tokenEstimation: admission.tokenEstimation }
      : {}),
  });
  return Object.freeze({
    ...prepared,
    assessment: admission.assessment,
    repairHeadroom,
  });
}
