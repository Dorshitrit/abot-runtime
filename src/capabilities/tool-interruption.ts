import type { ToolExecutionResult } from "./tool-types.js";

/** Adapter provenance and the executor's legacy abort receipt share one meaning. */
export function hasToolAbortReceipt(result: Pick<ToolExecutionResult,
  "ok" | "errorCode" | "interruption">): boolean {
  if (result.ok) return false;
  return result.interruption === "aborted" || result.errorCode === "request_aborted";
}
