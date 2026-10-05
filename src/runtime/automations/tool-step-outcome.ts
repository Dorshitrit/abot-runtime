import type { ToolExecutionResult, ToolNormalInvocationEffect } from "../../capabilities/tool-types.js";
import { hasToolAbortReceipt } from "../../capabilities/tool-interruption.js";
import type { RegisteredToolNormalInvocationResult } from "../adapters/registered-tool-normal-invocations/shared/contracts.js";

export type AutomationToolStepOutcome =
  | Readonly<{
      kind: "settled";
      ok: boolean;
      effect: ToolNormalInvocationEffect;
      result: ToolExecutionResult;
      completionActions: readonly { type: string; target?: string; details?: string }[];
      errorCode?: string;
    }>
  | Readonly<{ kind: "rejected"; code: string; message: string }>
  | Readonly<{ kind: "uncertain"; code: string; message: string }>;

export function classifyAutomationToolDispatchFailure(
  error: unknown,
  signal: AbortSignal,
  effect: ToolNormalInvocationEffect,
  dispatched: boolean,
): AutomationToolStepOutcome {
  const abortedByRun = signal.aborted && error === signal.reason;
  const uncertainEffect = dispatched && effect !== "read_only";
  const hasDefiniteAbort = abortedByRun && !uncertainEffect;
  if (hasDefiniteAbort)
    return { kind: "rejected", code: "request_aborted", message: String(error) };
  const mayHaveMutated = effect !== "read_only";
  if (mayHaveMutated)
    return { kind: "uncertain", code: "automation_effect_uncertain", message: String(error) };
  return { kind: "rejected", code: "automation_tool_failed", message: String(error) };
}

export function projectAutomationToolStepOutcome(
  settled: RegisteredToolNormalInvocationResult,
  effect: ToolNormalInvocationEffect,
  modelContextMissing: boolean,
): AutomationToolStepOutcome {
  const isAbortedMutatingRejection = settled.status === "rejected" &&
    settled.code === "request_aborted" && effect !== "read_only";
  if (isAbortedMutatingRejection)
    return { kind: "uncertain", code: "automation_effect_uncertain", message: settled.message };
  if (settled.status === "rejected")
    return { kind: "rejected", code: settled.code, message: settled.message };
  const isAbortedMutatingExecution = hasToolAbortReceipt(settled.result) &&
    effect !== "read_only";
  if (isAbortedMutatingExecution)
    return { kind: "uncertain", code: "automation_effect_uncertain", message: settled.result.output };
  return {
    kind: "settled",
    ok: settled.result.ok && !modelContextMissing,
    effect: settled.effect,
    result: settled.result,
    completionActions: settled.completionActions,
    ...(modelContextMissing ? { errorCode: "automation_tool_model_context_missing" } : {}),
  };
}
