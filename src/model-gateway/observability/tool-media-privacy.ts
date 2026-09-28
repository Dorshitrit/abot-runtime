import type { ModelGatewayEvent } from "../types.js";
import {
  ModelProviderContextWindowExceededError,
  ModelProviderEnvelopeInspectionError,
} from "./context-window-guard.js";

/** Detect typed request-only evidence before any model-content diagnostic sink. */
export function containsRequestToolMedia(value: unknown, depth = 0): boolean {
  if (depth > 40) return false;
  if (typeof value === "string") {
    const text = value.trim();
    // Serialized evidence may be embedded in a larger, human-readable prompt.
    // Fail closed for diagnostics; this marker never drives model actions.
    if (text.includes('"tool_image_v1"') || text.includes('\\"tool_image_v1\\"')) return true;
    if (!text.startsWith("{") && !text.startsWith("[")) return false;
    try { return containsRequestToolMedia(JSON.parse(text), depth + 1); } catch { return false; }
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsRequestToolMedia(item, depth + 1));
  const item = value as Record<string, unknown>;
  if (item.kind === "tool_image_v1" || item.toolEvidence !== undefined) return true;
  return Object.values(item).some((entry) => containsRequestToolMedia(entry, depth + 1));
}

export function toolMediaSafeError(error: unknown, input: unknown): unknown {
  if (!containsRequestToolMedia(input)) return error;
  // Preserve trusted admission contracts without retaining mutable error data.
  if (error instanceof ModelProviderContextWindowExceededError) {
    return new ModelProviderContextWindowExceededError();
  }
  if (error instanceof ModelProviderEnvelopeInspectionError) {
    return new ModelProviderEnvelopeInspectionError();
  }
  const safe = new Error("tool_media_provider_error: content omitted");
  if (error instanceof Error && error.name === "AbortError") safe.name = "AbortError";
  return safe;
}

export function toolMediaSafeMessage(message: string, input: unknown): string {
  return containsRequestToolMedia(input) ? "tool_media_provider_error: content omitted" : message;
}

export function toolMediaSafeEvent(event: ModelGatewayEvent, input: unknown): ModelGatewayEvent {
  return event.type === "error" ? { ...event, error: toolMediaSafeMessage(event.error, input) } : event;
}
