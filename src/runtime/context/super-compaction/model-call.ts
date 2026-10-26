import type { ChatMessage } from "../../../model-gateway/types.js";
import { MODEL_STEPS, type ModelStep } from "../../../shared/model-steps.js";
import { projectConfiguredStepMessages } from "../../config/runner/step-instructions.js";
import { countModelInputTokens } from "../../model/input-token-count.js";
import { RawModelValidationError } from "../../model/invoke-raw-step.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import { resolveOutputIncompleteError } from "../../model/provider-completion.js";
import type { BoundRequestModelInvocationContext } from "../../request/contracts.js";
import {
  assessRequestMessagesBudget,
  resolveRequestBudgetInputTokens,
} from "../request-context-budget.js";
import {
  buildSuperCompactionStageMessages,
  type SuperCompactionDerivedContext,
} from "./capsule.js";
import type { SuperCompactionStage } from "./instructions.js";

const STAGE_MODEL_STEPS: Readonly<Record<SuperCompactionStage, ModelStep>> =
  Object.freeze({
    coverage: MODEL_STEPS.SUPER_COMPACTION_COVERAGE,
    content: MODEL_STEPS.SUPER_COMPACTION_CONTENT,
    merge: MODEL_STEPS.SUPER_COMPACTION_MERGE,
    continuation: MODEL_STEPS.SUPER_COMPACTION_CONTINUATION,
  });
const TEXT_FORMAT = Object.freeze({
  type: "text",
  calibrationInstructions: "omit",
});
// A UTF-16 code unit needs at most three UTF-8 bytes. Reserve one token per byte
// for planned RAW output; actual subsequent input is independently admitted.
// Counting repeated placeholder text can undercount.
const DERIVED_TOKENS_PER_CHARACTER = 3;

export type SuperCompactionStageInput = Readonly<{
  request: BoundRequestModelInvocationContext;
  stage: SuperCompactionStage;
  baseMessages: readonly ChatMessage[];
  /** Writing target only; the next invocation admits the actual complete text. */
  maxCharacters: number;
  derived?: SuperCompactionDerivedContext;
  boundSteeringVersion?: number;
}>;

/** One exact invocation; mechanical output checks never make a semantic verdict. */
export async function invokeSuperCompactionStageText(
  input: SuperCompactionStageInput,
): Promise<string> {
  assertSuperCompactionCharacterLimit(input.maxCharacters);
  const modelStep = STAGE_MODEL_STEPS[input.stage];
  return input.request.modelSteps.invoke({
    modelStep,
    messages: buildSuperCompactionStageMessages(input),
    format: TEXT_FORMAT,
    contextRetention: "exact",
    boundSteeringVersion: input.boundSteeringVersion,
    timeoutReason: "super_compaction_timeout",
    accept(text, diagnostics, signal) {
      signal.throwIfAborted();
      const incomplete = resolveOutputIncompleteError(diagnostics, modelStep);
      if (incomplete) throw incomplete;
      const output = text.trim();
      if (!hasSuperCompactionOutput(output))
        throw new RawModelValidationError({
          reason: `invalid_super_compaction_${input.stage}_output`,
          stage: `raw_compaction_${input.stage}`,
          issues: [{
            code: "super_compaction_output_empty",
            path: "$",
            message: "Compaction output must contain non-whitespace text.",
          }],
        });
      return output;
    },
  });
}

export function invokeSuperContinuationText(
  input: Omit<SuperCompactionStageInput, "stage">,
): Promise<string> {
  return invokeSuperCompactionStageText({ ...input, stage: "continuation" });
}

/** Plan a window using writing targets; each invocation also admits its actual messages. */
export async function doesSuperCompactionPipelineFit(input: {
  request: BoundRequestModelInvocationContext;
  baseMessages: readonly ChatMessage[];
  limits: Readonly<{
    coverage: number;
    content: number;
    continuation?: number;
  }>;
}): Promise<boolean> {
  const coverageFits = await doesSuperCompactionStageFit({
    ...input,
    stage: "coverage",
    maxCharacters: input.limits.coverage,
  });
  if (!coverageFits) return false;
  const contentFits = await doesSuperCompactionStageFit(
    {
      ...input,
      stage: "content",
      maxCharacters: input.limits.content,
      derived: { coverage: "" },
    },
    input.limits.coverage,
  );
  if (!contentFits) return false;
  if (!hasSuperContinuationStage(input.limits)) return true;
  return doesSuperCompactionStageFit(
    {
      ...input,
      stage: "continuation",
      maxCharacters: input.limits.continuation!,
      derived: { coverage: "", content: "" },
    },
    input.limits.coverage + input.limits.content,
  );
}

/** Includes configured guidance and the worst-size pending derived output. */
export async function doesSuperCompactionStageFit(
  input: SuperCompactionStageInput,
  reservedDerivedCharacters = 0,
): Promise<boolean> {
  assertSuperCompactionCharacterLimit(input.maxCharacters);
  const { request } = input;
  const modelStep = STAGE_MODEL_STEPS[input.stage];
  const admission = resolveModelContextAdmission({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep,
    requestFormat: TEXT_FORMAT,
    modelPreference: request.modelPreference,
    reasoningPreference: request.reasoningPreference,
    modelPolicy: request.modelPolicy,
  });
  const projected = projectConfiguredStepMessages({
    runnerConfig: request.runnerConfig,
    modelStep,
    messages: buildSuperCompactionStageMessages(input),
  }).messages;
  const measured = await countModelInputTokens({
    request,
    modelStep,
    messages: projected,
    format: TEXT_FORMAT,
    invocation: admission.invocation,
  });
  const calibration = admission.invocation.instructions ?? [];
  const fallbackMessages =
    calibration.length === 0
      ? projected
      : [
          { role: "system" as const, content: calibration.join("\n") },
          ...projected,
        ];
  const assessment = assessRequestMessagesBudget({
    messages: fallbackMessages,
    budget: admission.budget,
    ...(measured === undefined ? {} : { measuredInputTokens: measured }),
  });
  const reservedTokens =
    reservedDerivedCharacters * DERIVED_TOKENS_PER_CHARACTER;
  return (
    resolveRequestBudgetInputTokens(assessment.budget) + reservedTokens <=
    assessment.budget.availableInputTokens
  );
}

function assertSuperCompactionCharacterLimit(maxCharacters: number): void {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1)
    throw new Error("super_compaction_character_limit_invalid");
}

function hasSuperCompactionOutput(output: string): boolean {
  return output.length > 0;
}

function hasSuperContinuationStage(
  limits: Readonly<{ continuation?: number }>,
): boolean {
  return limits.continuation !== undefined;
}
