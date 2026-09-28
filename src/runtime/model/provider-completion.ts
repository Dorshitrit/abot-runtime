import type { ModelStep } from "../../shared/model-steps.js";
import type { ModelStepOutputDiagnostics } from "./invoke-step.js";

/** A provider returned only a prefix because its physical output capacity ended. */
export class ModelOutputIncompleteError extends Error {
  readonly code = "output_incomplete";
  readonly stage = "provider_completion";
  readonly modelStep: ModelStep | undefined;
  readonly steeringVersion: number | undefined;
  readonly providerCompletionReason: string | null;
  readonly providerInputTokens?: number;
  readonly providerOutputTokens?: number;
  readonly providerTotalTokens?: number;

  constructor(diagnostics: ModelStepOutputDiagnostics, modelStep?: ModelStep) {
    super("output_incomplete");
    this.name = "ModelOutputIncompleteError";
    this.modelStep = modelStep;
    this.steeringVersion = diagnostics.steeringVersion;
    this.providerCompletionReason =
      diagnostics.providerCompletionReason ?? null;
    this.providerInputTokens = diagnostics.providerInputTokens;
    this.providerOutputTokens = diagnostics.providerOutputTokens;
    this.providerTotalTokens = diagnostics.providerTotalTokens;
  }
}

export function isOutputLimitCompletion(
  diagnostics: Pick<ModelStepOutputDiagnostics, "providerCompletionReason">,
): boolean {
  const reason = diagnostics.providerCompletionReason?.toLowerCase() ?? "";
  return (
    reason.includes("length") ||
    reason.includes("max_token") ||
    reason.includes("max_output")
  );
}

export function resolveOutputIncompleteError(
  diagnostics: ModelStepOutputDiagnostics,
  modelStep?: ModelStep,
): ModelOutputIncompleteError | undefined {
  return isOutputLimitCompletion(diagnostics)
    ? new ModelOutputIncompleteError(diagnostics, modelStep)
    : undefined;
}
