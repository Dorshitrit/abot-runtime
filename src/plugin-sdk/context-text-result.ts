import type { ToolImplementationOutput } from "../plugin-contract/entrypoint.js";
import type { ToolResultBudget } from "../capabilities/result-budget.js";
import type { ToolContextTextField } from "../capabilities/tool-context-text.js";
import { enforcePluginResultByteBudget } from "./results.js";

export type { ToolContextTextField } from "../capabilities/tool-context-text.js";

/**
 * Keeps ordinary results unchanged. An opted-in host can receive oversized
 * exact text in the same fields, with metadata still bounded. This is delivery
 * to runtime evidence, not permission to exceed the model's context window.
 */
export function deliverPluginTextResult(
  result: ToolImplementationOutput,
  fields: readonly ToolContextTextField[],
  budget?: ToolResultBudget,
): ToolImplementationOutput {
  const assessed = enforcePluginResultByteBudget(result, budget);
  if (!canHandOffContextText(result, assessed, budget)) return assessed;
  return enforcePluginResultByteBudget(
    { ...result, contextTextFields: Object.freeze([...fields]) },
    budget,
  );
}

function canHandOffContextText(
  original: ToolImplementationOutput,
  assessed: ToolImplementationOutput,
  budget: ToolResultBudget | undefined,
): boolean {
  if (budget?.acceptsContextText !== true) return false;
  if (assessed === original) return false;
  return assessed.errorCode === "plugin_result_too_large";
}
