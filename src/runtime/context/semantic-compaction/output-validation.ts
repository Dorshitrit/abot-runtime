import { countModelInputTokens } from "../../model/input-token-count.js";
import type { StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { estimateMessagesTokens } from "../token-estimator.js";
import { buildCheckpointMessage } from "./checkpoint-message.js";
import {
  CONTEXT_COMPACTION_MODEL_STEP,
  type SemanticCompactionCandidate,
} from "./contracts.js";
import type { SemanticCompactionGenerationParams } from "./generation-contracts.js";
import { parseSemanticCompactionOutput } from "./parser.js";
import {
  buildSemanticCompactionTokenBudgetIssue,
  type SemanticCompactionRepairValidation,
} from "./repair-headroom.js";
import type { prepareReplacementCompactionBudget } from "./replacement-budget.js";

type CheckpointContent = Pick<
  SemanticCompactionCandidate,
  "continuation" | "sourceDigests"
>;
type CheckpointBudget = ReturnType<typeof prepareReplacementCompactionBudget>;

/** Parse source identities first, then measure exactly the projected checkpoint. */
export async function validateSemanticCompactionOutput(
  text: string,
  params: SemanticCompactionGenerationParams,
  budget: CheckpointBudget,
  validation: SemanticCompactionRepairValidation,
  abortSignal: AbortSignal = params.request.abortSignal,
): Promise<StructuredModelParseResult<CheckpointContent>> {
  abortSignal.throwIfAborted();
  const parsed = parseSemanticCompactionOutput(text, budget.expectedSources);
  if (!parsed.ok)
    return reject(parsed.issueCode, validation.message, params, validation);
  const candidate: SemanticCompactionCandidate = Object.freeze({
    kind: "runtime_semantic_compaction_checkpoint_v2",
    scopeId: params.scopeId,
    ...params.binding,
    sourceRevision: params.sourceRevision,
    sourceDigests: parsed.sourceDigests,
    continuation: parsed.continuation,
  });
  const messages = [buildCheckpointMessage(candidate)];
  for (const consumerBudget of budget.consumers) {
    const measured = await countModelInputTokens({
      request: params.request,
      abortSignal,
      invocation: consumerBudget.admission.invocation,
      modelStep: consumerBudget.consumer,
      messages,
      // Measure this passive input without inheriting the consumer's output contract.
      format: { type: "text" },
    });
    const inputTokens =
      measured ??
      estimateMessagesTokens(
        messages,
        consumerBudget.admission.budget.tokenEstimation,
      );
    const fitsCheckpointTokenBudget =
      inputTokens <= consumerBudget.checkpointTokenAllowance;
    traceDebug("runtime.context.compaction", "checkpoint.budget", {
      requestId: params.request.requestId,
      scopeId: params.scopeId,
      sourceRevision: params.sourceRevision,
      consumer: consumerBudget.consumer,
      profileId: consumerBudget.admission.invocation.profile.id,
      contextWindowTokens: consumerBudget.admission.budget.contextWindowTokens,
      checkpointTokenAllowance: consumerBudget.checkpointTokenAllowance,
      checkpointInputTokens: inputTokens,
      measurement: measured === undefined ? "estimated" : "actual",
      accepted: fitsCheckpointTokenBudget,
    });
    if (!fitsCheckpointTokenBudget) {
      return reject(
        "context_compaction_checkpoint_tokens_exceeded",
        buildSemanticCompactionTokenBudgetIssue(
          inputTokens,
          consumerBudget.checkpointTokenAllowance,
        ),
        params,
        validation,
      );
    }
  }
  return Object.freeze({
    ok: true as const,
    decision: Object.freeze({
      continuation: parsed.continuation,
      sourceDigests: parsed.sourceDigests,
    }),
  });
}

function reject(
  issueCode: string,
  message: string,
  params: SemanticCompactionGenerationParams,
  validation: SemanticCompactionRepairValidation,
): StructuredModelParseResult<CheckpointContent> {
  traceDebug("runtime.context.compaction", "model.rejected", {
    requestId: params.request.requestId,
    modelStep: CONTEXT_COMPACTION_MODEL_STEP,
    scopeId: params.scopeId,
    sourceRevision: params.sourceRevision,
    issueCode,
  });
  return Object.freeze({
    ok: false as const,
    stage: validation.stage,
    issues: Object.freeze([
      Object.freeze({ code: issueCode, path: validation.path, message }),
    ]),
  });
}
