import { randomUUID } from "node:crypto";
import { isPlainObject } from "../../structured-output/format-contract.js";
import { readLlamaCppRenderResponse } from "./system-message-render-response.js";

import {
  describeLlamaCppMarkerMismatch, describeLlamaCppMissingToolNames,
  reportLlamaCppRenderDiagnostic, type LlamaCppRenderObserver,
} from "./system-message-render-diagnostics.js";

type WireMessage = Record<string, unknown>;
type ProbeParams = {
  payload: Record<string, unknown>;
  url: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  mergeLeading?: boolean;
  onDiagnostic?: LlamaCppRenderObserver;
};

function invalidShape(): never {
  throw new TypeError("llamacpp_system_message_render_invalid_shape");
}

/** Only consecutive leading text-only system messages can share one wire position. */
export function mergeLeadingLlamaCppSystemMessages(messages: readonly WireMessage[]): WireMessage[] {
  const nextRole = messages.findIndex((message) => message.role !== "system");
  const end = nextRole === -1 ? messages.length : nextRole;
  if (end < 2) return [...messages];
  const leading = messages.slice(0, end).map((message) => {
    if (typeof message.content !== "string" || Object.keys(message).length !== 2) return invalidShape();
    return message.content;
  });
  return [{ role: "system", content: leading.join("\n\n") }, ...messages.slice(end)];
}

function createRenderProbe(payload: ProbeParams["payload"], mergeLeading: boolean) {
  if (!Array.isArray(payload.messages) || !payload.messages.length) return invalidShape();
  const prefix = `ABOT${randomUUID().replaceAll("-", "")}X`;
  const markers: string[] = [];
  const calls = new Map<string, { id: string; name: string }>();
  const names = new Map<string, string>();
  const actions: Array<{ index: number; name: string }> = [];
  function marker() {
    const value = `${prefix}${markers.length}Z`;
    markers.push(value);
    return value;
  }
  function toolName(name: unknown) {
    if (typeof name !== "string" || !name) return invalidShape();
    const existing = names.get(name);
    if (existing) return existing;
    const synthetic = `probe_${randomUUID().replaceAll("-", "")}`;
    names.set(name, synthetic);
    return synthetic;
  }
  function projectToolCall(call: unknown) {
    if (!isPlainObject(call) || typeof call.id !== "string" || !isPlainObject(call.function)) return invalidShape();
    if (calls.has(call.id)) return invalidShape();
    const id = String(calls.size + 1).padStart(9, "0");
    const name = toolName(call.function.name);
    calls.set(call.id, { id, name });
    actions.push({ index: markers.length, name });
    return { id, type: "function", function: { name, arguments: JSON.stringify({ probe: marker() }) } };
  }
  function projectMessage(message: unknown): WireMessage {
    if (!isPlainObject(message) || typeof message.content !== "string") return invalidShape();
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      if (message.content !== "" || !message.tool_calls.length) return invalidShape();
      return { role: "assistant", content: "", tool_calls: message.tool_calls.map(projectToolCall) };
    }
    if (message.role === "tool") {
      const call = typeof message.tool_call_id === "string" && calls.get(message.tool_call_id);
      if (!call) return invalidShape();
      return { role: "tool", tool_call_id: call.id, name: call.name, content: marker() };
    }
    if (message.role !== "assistant" && message.role !== "system" && message.role !== "user") return invalidShape();
    return { role: message.role, content: marker() };
  }
  const messages = payload.messages.map(projectMessage);
  const body: Record<string, unknown> = {
    model: payload.model,
    messages: mergeLeading ? mergeLeadingLlamaCppSystemMessages(messages) : messages,
  };
  for (const key of ["reasoning_effort", "reasoning_format", "reasoning_budget_tokens"] as const) {
    if (Object.hasOwn(payload, key)) body[key] = payload[key];
  }
  if (isPlainObject(payload.chat_template_kwargs) && typeof payload.chat_template_kwargs.enable_thinking === "boolean") {
    body.chat_template_kwargs = { enable_thinking: payload.chat_template_kwargs.enable_thinking };
  }
  if (isPlainObject(payload.response_format)) {
    body.response_format = payload.response_format.type === "json_schema"
      ? { type: "json_schema", json_schema: { name: "render_probe", schema: { type: "object" } } }
      : { type: payload.response_format.type };
  }
  return { body, markers, prefix, actions };
}

/** Inspect the server's non-generating render without requiring a specific template dialect. */
export async function inspectLlamaCppSystemMessageRender(params: ProbeParams): Promise<"preserved" | "incompatible"> {
  const { body, markers, prefix, actions } = createRenderProbe(params.payload, params.mergeLeading === true);
  const { signal, onDiagnostic } = params;
  let httpStatus: number | undefined;
  try {
    signal?.throwIfAborted();
    const response = await params.fetchImpl(params.url, {
      method: "POST", headers: params.headers, redirect: "error", signal, body: JSON.stringify(body),
    });
    httpStatus = response.status;
    const prompt = await readLlamaCppRenderResponse(response, signal);
    signal?.throwIfAborted();
    if (prompt === undefined) {
      reportLlamaCppRenderDiagnostic(onDiagnostic, () => ({ outcome: "incompatible", reason: "template_refused", httpStatus }));
      return "incompatible";
    }
    const markerPattern = new RegExp(`${prefix}[0-9]+Z`, "g");
    const observed = prompt.match(markerPattern) ?? [];
    if (observed.length !== markers.length || !observed.every((mark, index) => mark === markers[index])) {
      reportLlamaCppRenderDiagnostic(onDiagnostic, () => ({
        outcome: "incompatible", reason: "marker_mismatch", httpStatus,
        ...describeLlamaCppMarkerMismatch(markers, observed),
      }));
      return "incompatible";
    }
    if (!actions.length) {
      reportLlamaCppRenderDiagnostic(onDiagnostic, () => ({
        outcome: "preserved", reason: "preserved", httpStatus,
        expectedMarkerCount: markers.length, observedMarkerCount: observed.length,
      }));
      return "preserved";
    }
    // A template can retain the arguments and receipt text while dropping which function was called.
    // The name may precede or follow its arguments. The receipt can use an ID or implicit order.
    const gaps = prompt.split(markerPattern);
    const preserved = actions.every(({ index, name }) => gaps[index]!.includes(name) || gaps[index + 1]!.includes(name));
    reportLlamaCppRenderDiagnostic(onDiagnostic, () => ({
      outcome: preserved ? "preserved" : "incompatible", reason: preserved ? "preserved" : "tool_name_missing", httpStatus,
      expectedMarkerCount: markers.length, observedMarkerCount: observed.length,
      ...describeLlamaCppMissingToolNames(actions, gaps),
    }));
    return preserved ? "preserved" : "incompatible";
  } catch (error) {
    reportLlamaCppRenderDiagnostic(onDiagnostic, () => ({
      outcome: signal?.aborted ? "aborted" : "error", reason: signal?.aborted ? "aborted" : "render_error", httpStatus,
    }));
    signal?.throwIfAborted();
    if (error instanceof SyntaxError) throw new Error("llamacpp_system_message_render_invalid_response");
    if (error instanceof Error && /^llamacpp_system_message_render_(http_\d{3}|invalid_response|response_too_large)$/.test(error.message)) throw error;
    throw new Error("llamacpp_system_message_render_unavailable");
  }
}
