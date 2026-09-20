import type {
  ToolCall,
  ToolCallAdapter,
} from "../../../../capabilities/tool-types.js";
import { rejectNormalInvocation } from "../shared/rejection.js";

/** Private execution identity and human disclosure never enter model controls. */
export function captureExecutionBinding(
  adapter: ToolCallAdapter | undefined,
  call: ToolCall,
):
  | Readonly<{
      ok: true;
      identity?: string;
      metadata?: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      ok: false;
      rejection: ReturnType<typeof rejectNormalInvocation>;
    }> {
  if (!adapter?.executionBinding) return { ok: true };
  try {
    const binding = adapter.executionBinding(call);
    if (!hasBoundExecutionIdentity(binding)) {
      return rejectExecutionBinding();
    }
    return Object.freeze({
      ok: true as const,
      identity: binding.identity,
      ...(binding.metadata
        ? { metadata: Object.freeze(structuredClone(binding.metadata)) }
        : {}),
    });
  } catch {
    return rejectExecutionBinding();
  }
}

function hasBoundExecutionIdentity(binding: unknown): binding is Readonly<{
  identity: string;
  metadata?: Readonly<Record<string, unknown>>;
}> {
  if (!binding || typeof binding !== "object") return false;
  if (!("identity" in binding)) return false;
  if (typeof binding.identity !== "string") return false;
  return binding.identity.trim().length > 0;
}

function rejectExecutionBinding() {
  return {
    ok: false as const,
    rejection: rejectNormalInvocation(
      "normal_invocation_execution_binding_unavailable",
      "The registered action could not bind its execution destination for this request.",
    ),
  };
}
