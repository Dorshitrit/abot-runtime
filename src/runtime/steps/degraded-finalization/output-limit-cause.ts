import { MODEL_STEPS } from "../../../shared/model-steps.js";
import {
  isOutputLimitCompletion,
  ModelOutputIncompleteError,
} from "../../model/provider-completion.js";
import type { DegradedFinalizationProblem } from "./contract.js";

/** Presentation facts only: never expose provider text or infer work progress. */
export function projectOutputLimitCause(
  error: unknown,
): Pick<DegradedFinalizationProblem, "cause" | "modelStep"> | undefined {
  if (!(error instanceof ModelOutputIncompleteError)) return undefined;
  if (!isOutputLimitCompletion(error)) return undefined;
  const modelStep = Object.values(MODEL_STEPS).find(
    (step) => step === error.modelStep,
  );
  return {
    cause: "model_output_limit",
    ...(modelStep ? { modelStep } : {}),
  };
}

export function hasModelOutputLimitCause(
  problem: DegradedFinalizationProblem,
): boolean {
  return problem.cause === "model_output_limit";
}
