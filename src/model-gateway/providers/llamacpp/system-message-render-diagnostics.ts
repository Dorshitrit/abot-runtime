import { randomUUID } from "node:crypto";
import { traceDebug } from "../../../runtime/observability/debug-logger.js";
import type { ModelProviderInvocationParams } from "../contracts.js";
import type { LlamaCppChatPayload } from "./payload.js";
import type { SystemMessageLayout } from "./system-message-layouts.js";

const MAX_DIAGNOSTIC_ITEMS = 128;
type RenderOutcome = "preserved" | "incompatible" | "error" | "aborted" | "skipped";
type RenderReason = "preserved" | "template_refused" | "marker_mismatch" | "tool_name_missing"
  | "render_error" | "aborted" | "measurement_mismatch";

export type LlamaCppRenderDiagnostic = {
  outcome: RenderOutcome;
  reason: RenderReason;
  httpStatus?: number;
  expectedMarkerCount?: number;
  observedMarkerCount?: number;
  observedMarkerIndices?: number[];
  observedMarkerIndicesOmitted?: number;
  missingMarkerIndices?: number[];
  missingMarkerIndicesOmitted?: number;
  duplicatedMarkerIndices?: number[];
  duplicatedMarkerIndicesOmitted?: number;
  unexpectedMarkerCount?: number;
  firstMismatchPosition?: number;
  missingToolNameMarkerIndices?: number[];
  missingToolNameMarkerIndicesOmitted?: number;
};
export type LlamaCppRenderObserver = (diagnostic: LlamaCppRenderDiagnostic) => void;

/** Logging and diagnostic calculations are observers, never decision inputs. */
export function reportLlamaCppRenderDiagnostic(
  observer: LlamaCppRenderObserver | undefined,
  describe: () => LlamaCppRenderDiagnostic,
): void {
  try { if (observer) observer(describe()); } catch { /* Preserve the provider result. */ }
}

function safeDiagnosticId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) ? value : undefined;
}

function diagnosticRoles(payload: LlamaCppChatPayload): string[] {
  return payload.messages.slice(0, MAX_DIAGNOSTIC_ITEMS).map(({ role }) => {
    if (role === "system" || role === "user" || role === "assistant" || role === "tool") return role;
    return "unknown";
  });
}

function diagnosticMarkerCounts(payload: LlamaCppChatPayload): number[] {
  return payload.messages.slice(0, MAX_DIAGNOSTIC_ITEMS).map(message => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) return message.tool_calls.length;
    return 1;
  });
}

export function createLlamaCppRenderDiagnostics(
  params: ModelProviderInvocationParams,
  source: LlamaCppChatPayload,
  contextIndices: ReadonlySet<number>,
  originalMessageCount: number,
  operation: "count" | "invoke",
) {
  let packingId: string | undefined;
  return (layout: SystemMessageLayout, layoutIndex: number): LlamaCppRenderObserver => (diagnostic) => {
    try {
      packingId ??= randomUUID();
      traceDebug("model-gateway.server", "llamacpp.template.inspected", {
        packingId, operation, layoutIndex, layout: layout.kind,
        requestId: safeDiagnosticId(params.requestBody.debugRequestId),
        modelStep: safeDiagnosticId(params.requestBody.modelStep),
        profileId: safeDiagnosticId(params.invocation.profile.id),
        providerId: safeDiagnosticId(params.invocation.profile.providerId),
        model: safeDiagnosticId(params.invocation.model),
        endpoint: "apply-template",
        measurementPinned: params.inputTokenMeasurement?.providerEnvelopeFingerprint !== undefined,
        sourceMessageCount: source.messages.length,
        sourceRoles: diagnosticRoles(source),
        sourceRolesOmitted: Math.max(0, source.messages.length - MAX_DIAGNOSTIC_ITEMS),
        // The sidecar indices refer to caller messages, before the provider's leading instructions.
        originalMessageCount,
        providerMessageOffset: source.messages.length - originalMessageCount,
        invocationContextMessageIndices: [...contextIndices].slice(0, MAX_DIAGNOSTIC_ITEMS),
        invocationContextIndicesOmitted: Math.max(0, contextIndices.size - MAX_DIAGNOSTIC_ITEMS),
        probeMessageCount: layout.probePayload.messages.length,
        probeRoles: diagnosticRoles(layout.probePayload),
        probeMarkerCounts: diagnosticMarkerCounts(layout.probePayload),
        probeRolesOmitted: Math.max(0, layout.probePayload.messages.length - MAX_DIAGNOSTIC_ITEMS),
        wireMessageCount: layout.payload.messages.length,
        wireRoles: diagnosticRoles(layout.payload),
        wireRolesOmitted: Math.max(0, layout.payload.messages.length - MAX_DIAGNOSTIC_ITEMS),
        ...diagnostic,
      });
    } catch { /* Logging cannot replace the provider's result or cancellation. */ }
  };
}

/** Marker indices refer to the pre-merge probe sequence, including each native call's arguments. */
export function describeLlamaCppMarkerMismatch(markers: readonly string[], observed: readonly string[]) {
  const expected = new Map(markers.map((marker, index) => [marker, index]));
  const counts = new Map<string, number>();
  for (const marker of observed) counts.set(marker, (counts.get(marker) ?? 0) + 1);
  const missing = markers.flatMap((marker, index) => counts.has(marker) ? [] : [index]);
  const duplicated = markers.flatMap((marker, index) => (counts.get(marker) ?? 0) > 1 ? [index] : []);
  const firstDifferent = observed.findIndex((marker, index) => marker !== markers[index]);
  return {
    expectedMarkerCount: markers.length, observedMarkerCount: observed.length,
    observedMarkerIndices: observed.slice(0, MAX_DIAGNOSTIC_ITEMS).map(marker => expected.get(marker) ?? -1),
    observedMarkerIndicesOmitted: Math.max(0, observed.length - MAX_DIAGNOSTIC_ITEMS),
    missingMarkerIndices: missing.slice(0, MAX_DIAGNOSTIC_ITEMS),
    missingMarkerIndicesOmitted: Math.max(0, missing.length - MAX_DIAGNOSTIC_ITEMS),
    duplicatedMarkerIndices: duplicated.slice(0, MAX_DIAGNOSTIC_ITEMS),
    duplicatedMarkerIndicesOmitted: Math.max(0, duplicated.length - MAX_DIAGNOSTIC_ITEMS),
    unexpectedMarkerCount: observed.filter(marker => !expected.has(marker)).length,
    firstMismatchPosition: firstDifferent < 0 ? Math.min(markers.length, observed.length) : firstDifferent,
  };
}

export function describeLlamaCppMissingToolNames(
  actions: readonly { index: number; name: string }[],
  gaps: readonly string[],
) {
  const missing = actions.filter(({ index, name }) => !gaps[index]!.includes(name) && !gaps[index + 1]!.includes(name));
  return {
    missingToolNameMarkerIndices: missing.slice(0, MAX_DIAGNOSTIC_ITEMS).map(({ index }) => index),
    missingToolNameMarkerIndicesOmitted: Math.max(0, missing.length - MAX_DIAGNOSTIC_ITEMS),
  };
}
