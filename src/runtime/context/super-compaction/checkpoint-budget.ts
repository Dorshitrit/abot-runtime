import { projectSuperContinuation } from "./continuation-projection.js";
import { countModelInputTokens } from "../../model/input-token-count.js";
import { estimateMessagesTokens } from "../token-estimator.js";
import { buildCheckpointMessage } from "../semantic-compaction/checkpoint-message.js";
import type {
  SemanticCompactionCandidate,
  SemanticCompactionSource,
} from "../semantic-compaction/contracts.js";
import type { SemanticCompactionGenerationParams } from "../semantic-compaction/generation-contracts.js";
import { prepareReplacementCompactionBudget } from "../semantic-compaction/replacement-budget.js";
import {
  createSuperContinuation,
  SUPER_CONTINUATION_MAX_CHARACTERS,
} from "./continuation.js";

const MAX_SOURCE_DIGEST_CHARACTERS = 2_400;

/** Plan compact writing allowances; final admission still measures actual tokens. */
export async function prepareSuperCheckpointBudget(
  params: SemanticCompactionGenerationParams,
  sources: readonly SemanticCompactionSource[],
) {
  const budget = prepareReplacementCompactionBudget(params);
  const skeleton: SemanticCompactionCandidate = {
    ...params.binding,
    kind: "runtime_semantic_compaction_checkpoint_v2",
    scopeId: params.scopeId,
    sourceRevision: params.sourceRevision,
    sourceDigests: sources.map(({ sourceRef, sourceFingerprint }) => ({
      sourceRef,
      sourceFingerprint,
      digest: "",
    })),
    continuation: createSuperContinuation(""),
  };
  const overhead = Math.max(
    ...(await Promise.all(
      budget.consumers.map((consumer) =>
        measureCheckpoint(params, skeleton, consumer),
      ),
    )),
  );
  // One token per planned character leaves room for ordinary prose. This is a
  // writing target, not a token-count guarantee for arbitrary scripts/providers.
  const availableCharacters = Math.floor(
    budget.checkpointTokenAllowance -
      overhead -
      SUPER_CONTINUATION_MAX_CHARACTERS,
  );
  const minimums = sources.map(() => 256);
  const minimumTotal = minimums.reduce((sum, value) => sum + value, 0);
  // Minimum writing targets may exceed the allowance; only the actual checkpoint
  // can establish whether all retained evidence fits its consumers.
  const distributable = Math.max(0, availableCharacters - minimumTotal);
  const totalWeight = sources.reduce(
    (sum, source) => sum + source.content.length,
    0,
  );
  const sourceCharacterLimits = sources.map((source, index) =>
    Math.min(
      MAX_SOURCE_DIGEST_CHARACTERS,
      minimums[index]! +
        Math.floor((distributable * source.content.length) / totalWeight),
    ),
  );
  return Object.freeze({
    budget,
    sourceCharacterLimits: Object.freeze(sourceCharacterLimits),
  });
}

export async function assertSuperCheckpointFits(
  params: SemanticCompactionGenerationParams,
  candidate: SemanticCompactionCandidate,
  budget: ReturnType<typeof prepareReplacementCompactionBudget>,
): Promise<void> {
  for (const consumer of budget.consumers) {
    const tokens = await measureCheckpoint(params, candidate, consumer);
    if (!isWithinCheckpointAllowance(tokens, consumer.checkpointTokenAllowance))
      throw new Error("context_compaction_checkpoint_tokens_exceeded");
  }
}

async function measureCheckpoint(
  params: SemanticCompactionGenerationParams,
  candidate: SemanticCompactionCandidate,
  consumer: ReturnType<
    typeof prepareReplacementCompactionBudget
  >["consumers"][number],
): Promise<number> {
  params.request.abortSignal.throwIfAborted();
  const messages = [
    buildCheckpointMessage(candidate, {
      projectContinuation: projectSuperContinuation,
    }),
  ];
  const measured = await countModelInputTokens({
    request: params.request,
    modelStep: consumer.consumer,
    invocation: consumer.admission.invocation,
    messages,
    format: { type: "text" },
  });
  return (
    measured ??
    estimateMessagesTokens(messages, consumer.admission.budget.tokenEstimation)
  );
}

function isWithinCheckpointAllowance(
  tokens: number,
  allowance: number,
): boolean {
  return tokens <= allowance;
}
