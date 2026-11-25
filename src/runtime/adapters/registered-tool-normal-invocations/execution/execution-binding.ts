import type {
  ToolCall,
  ToolCallAdapter,
  ToolExecutionBinding,
} from "../../../../capabilities/tool-types.js";
import type { RegisteredToolNormalInvocationExecutorParams } from "../shared/contracts.js";
import { rejectNormalInvocation } from "../shared/rejection.js";

/** Private execution identity and human disclosure never enter model controls. */
export async function captureExecutionBinding(
  adapter: ToolCallAdapter | undefined,
  call: ToolCall,
  executor: Pick<RegisteredToolNormalInvocationExecutorParams, "toolPermissionMode" | "sharedState" | "abortSignal">,
): Promise<
  | Readonly<{
      ok: true;
      identity?: string;
      metadata?: Readonly<Record<string, unknown>>;
      requiresApproval?: boolean;
    }>
  | Readonly<{
      ok: false;
      rejection: ReturnType<typeof rejectNormalInvocation>;
    }>> {
  executor.abortSignal.throwIfAborted();
  if (!adapter?.executionBinding) return { ok: true };
  try {
    const binding = await waitForExecutionBinding(adapter.executionBinding(call, Object.freeze({
      toolPermissionMode: executor.toolPermissionMode,
      ...(executor.sharedState?.currentSessionId
        ? { sessionId: executor.sharedState.currentSessionId }
        : {}),
      abortSignal: executor.abortSignal,
    })), executor.abortSignal);
    executor.abortSignal.throwIfAborted();
    if (!hasBoundExecutionIdentity(binding)) {
      return rejectExecutionBinding();
    }
    return Object.freeze({
      ok: true as const,
      identity: binding.identity,
      ...(binding.requiresApproval === true ? { requiresApproval: true } : {}),
      ...(binding.metadata
        ? { metadata: Object.freeze(structuredClone(binding.metadata)) }
        : {}),
    });
  } catch (error) {
    executor.abortSignal.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    return rejectExecutionBinding(error);
  }
}

function hasBoundExecutionIdentity(binding: unknown): binding is ToolExecutionBinding {
  if (!binding || typeof binding !== "object") return false;
  if (!("identity" in binding)) return false;
  if (typeof binding.identity !== "string") return false;
  if ("requiresApproval" in binding && binding.requiresApproval !== undefined &&
    typeof binding.requiresApproval !== "boolean") return false;
  if ("metadata" in binding && binding.metadata !== undefined &&
    !isDisclosureRecord(binding.metadata)) return false;
  return binding.identity.trim().length > 0;
}

function isDisclosureRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object") return false;
  return !Array.isArray(value);
}

/** Cancellation must not wait for a plugin's pending target lookup to settle. */
async function waitForExecutionBinding(
  pending: ToolExecutionBinding | Promise<ToolExecutionBinding>,
  signal: AbortSignal,
): Promise<ToolExecutionBinding> {
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function rejectExecutionBinding(error?: unknown) {
  return {
    ok: false as const,
    rejection: rejectNormalInvocation(
      executionBindingFailureCode(error) ?? "normal_invocation_execution_binding_unavailable",
      executionBindingFailureMessage(error) ??
        "The registered action could not bind its execution destination for this request.",
    ),
  };
}

function executionBindingFailureCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!("code" in error) || typeof error.code !== "string") return undefined;
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(error.code)) return undefined;
  return error.code;
}

function executionBindingFailureMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (typeof error.message !== "string") return undefined;
  if (!error.message.trim()) return undefined;
  return error.message;
}
