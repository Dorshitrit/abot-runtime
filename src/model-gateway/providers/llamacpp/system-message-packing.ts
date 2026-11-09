import type { ModelProviderInvocationError, ModelProviderInvocationParams } from "../contracts.js";
import { createProviderEnvelopeFingerprint } from "../envelope-budget.js";
import { buildLlamaCppChatPayload, type LlamaCppChatPayload } from "./payload.js";
import type { resolveLlamaCppProviderSettings } from "./settings.js";
import { llamaCppSystemMessageLayouts, readLlamaCppInvocationContextIndices } from "./system-message-layouts.js";
import { inspectLlamaCppSystemMessageRender } from "./system-message-render.js";

import { createLlamaCppRenderDiagnostics, reportLlamaCppRenderDiagnostic } from "./system-message-render-diagnostics.js";

type PreparedChat = { kind: "ready"; payload: LlamaCppChatPayload } | ModelProviderInvocationError;

function requiresHistoryInspection(payload: LlamaCppChatPayload): boolean {
  // A valid native call always has a tool result, even without a system instruction.
  return payload.messages.some((message, index) => message.role === "tool" || (index > 0 && message.role === "system"));
}

export async function prepareLlamaCppSystemMessages(
  params: ModelProviderInvocationParams,
  settings: ReturnType<typeof resolveLlamaCppProviderSettings>,
  renderFetch: typeof fetch,
  operation: "count" | "invoke" = "invoke",
): Promise<PreparedChat> {
  const indices = readLlamaCppInvocationContextIndices(params.requestBody);
  if (!indices) return { kind: "error", statusCode: 400, message: "llamacpp_invocation_context_indices_invalid" };
  const payload = buildLlamaCppChatPayload(params);
  if (!requiresHistoryInspection(payload)) return { kind: "ready", payload };
  const originalMessageCount = Array.isArray(params.requestBody.messages) ? params.requestBody.messages.length : 0;
  const layouts = llamaCppSystemMessageLayouts(payload, indices, originalMessageCount);
  const fingerprint = params.inputTokenMeasurement?.providerEnvelopeFingerprint;
  const diagnostics = createLlamaCppRenderDiagnostics(params, payload, indices, originalMessageCount, operation);
  let layoutIndex = 0;
  const probe = {
    url: `${settings.serverUrl}/apply-template`, headers: settings.headers,
    fetchImpl: renderFetch, signal: params.abortSignal,
  };
  try {
    for (const layout of layouts) {
      const onDiagnostic = diagnostics(layout, ++layoutIndex);
      // A measurement pins the exact representation. Recheck it against the currently loaded template.
      if (fingerprint !== undefined && createProviderEnvelopeFingerprint(layout.payload) !== fingerprint) {
        reportLlamaCppRenderDiagnostic(onDiagnostic, () => ({ outcome: "skipped", reason: "measurement_mismatch" }));
        continue;
      }
      const rendered = await inspectLlamaCppSystemMessageRender({
        ...probe, payload: layout.probePayload, mergeLeading: layout.mergeLeading, onDiagnostic,
      });
      if (rendered === "preserved") return { kind: "ready", payload: layout.payload };
      if (fingerprint !== undefined) break;
    }
  } catch (error) {
    params.abortSignal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { kind: "error", statusCode: 502, message: "llamacpp_system_message_render_unavailable" };
  }
  return { kind: "error", statusCode: 400, message: "llamacpp_system_message_order_unsupported" };
}
