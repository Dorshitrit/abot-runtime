import type { ToolImplementationOutput } from "../plugin-contract/entrypoint.js";
import {
  successResult,
  type SuccessResultInput,
  type ToolResultBudget,
} from "./results.js";

/**
 * Reports a mutation already confirmed by the owning plugin. This helper
 * preserves its receipt; it does not execute or independently verify a change.
 */
export function mutationSuccessResult(
  input: SuccessResultInput,
  resultBudget?: ToolResultBudget,
): ToolImplementationOutput {
  return successResult(
    {
      ...input,
      data: { ...input.data, mutationEvidence: true },
    },
    resultBudget,
  );
}
