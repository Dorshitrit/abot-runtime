import { permitsRequiredToolMode } from "../../../../capabilities/tool-permission-mode.js";
import type { BoundOperation, RegisteredToolNormalInvocationExecutorParams } from "../shared/contracts.js";
import { materializeCall } from "../execution/call-binding.js";
import { validatePublicInput } from "./input-preparation.js";

/** The same captured registration, input validation and permission as execution. */
export function bindPayloadPreparation(
  source: BoundOperation,
  executor: RegisteredToolNormalInvocationExecutorParams,
) {
  const prepare = source.registration.adapter?.preparePayload;
  if (!prepare) return undefined;
  if (!source.operation.payload || source.stagedPayloadPlan) {
    throw new Error("payload_source_requires_single_payload");
  }
  return async (controls: Readonly<Record<string, unknown>>) => {
    executor.abortSignal.throwIfAborted();
    if (!permitsRequiredToolMode(executor.toolPermissionMode,
      source.registration.definition.requiredPermissionMode)) {
      throw new Error("tool_permission_mode_required");
    }
    const validated = validatePublicInput(source, controls);
    if (!validated.ok) throw new Error("payload_source_controls_invalid");
    const pending = prepare(materializeCall(source, validated.value, undefined), {
      toolPermissionMode: executor.toolPermissionMode,
      sessionId: executor.sharedState?.currentSessionId,
      abortSignal: executor.abortSignal,
    });
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new DOMException("Payload source preparation aborted.", "AbortError"));
    executor.abortSignal.addEventListener("abort", onAbort, { once: true });
    try {
      if (executor.abortSignal.aborted) onAbort();
      const result = await Promise.race([pending, aborted]);
      executor.abortSignal.throwIfAborted();
      return result;
    } finally { executor.abortSignal.removeEventListener("abort", onAbort); }
  };
}
