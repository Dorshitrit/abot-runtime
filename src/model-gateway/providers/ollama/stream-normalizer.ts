import type { ModelGatewayEvent, ModelTokenUsage } from "../../types.js";
import type { ModelProviderEventSink } from "../contracts.js";
import { buildModelTokenUsage } from "../../protocol/usage.js";

export type OllamaProviderTiming = Readonly<{
  loadDurationNs?: number;
  promptEvalDurationNs?: number;
  evalDurationNs?: number;
  totalDurationNs?: number;
}>;

export type OllamaStreamOptions = Readonly<{
  onTerminalTiming?: (timing: OllamaProviderTiming) => void;
  onNormalizedEvent?: (event: ModelGatewayEvent) => void;
}>;

function observeNormalizedEvent(
  options: OllamaStreamOptions,
  event: ModelGatewayEvent,
): void {
  try {
    options.onNormalizedEvent?.(event);
  } catch {
    // Diagnostics must never affect provider stream behavior.
  }
}

function readOllamaEvent(json: unknown): ModelGatewayEvent[] {
  const obj =
    json && typeof json === "object"
      ? (json as {
          message?: { thinking?: unknown; content?: unknown };
          done?: unknown;
          done_reason?: unknown;
          prompt_eval_count?: unknown;
          eval_count?: unknown;
        })
      : {};
  const thinking = obj.message?.thinking;
  const content = obj.message?.content;
  const doneFlag = obj.done === true;
  const doneReason = obj.done_reason;
  const events: ModelGatewayEvent[] = [];

  if (typeof thinking === "string" && thinking.length > 0) {
    events.push({ type: "thinking", text: thinking });
  }

  if (typeof content === "string" && content.length > 0) {
    events.push({ type: "content", text: content });
  }

  if (doneFlag) {
    const usage = readOllamaUsage(obj);
    events.push({
      type: "done",
      done: true,
      doneReason: typeof doneReason === "string" ? doneReason : null,
      ...(usage ? { usage } : {}),
    });
  }

  return events;
}

function readOllamaUsage(json: unknown): ModelTokenUsage | undefined {
  const value =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  return buildModelTokenUsage({
    inputTokens: value.prompt_eval_count,
    outputTokens: value.eval_count,
  });
}

function readOllamaProviderTiming(
  json: unknown,
): OllamaProviderTiming | undefined {
  const value =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  if (value.done !== true) {
    return undefined;
  }
  const readDuration = (field: string): number | undefined => {
    const duration = value[field];
    return typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration >= 0
      ? duration
      : undefined;
  };
  const loadDurationNs = readDuration("load_duration");
  const promptEvalDurationNs = readDuration("prompt_eval_duration");
  const evalDurationNs = readDuration("eval_duration");
  const totalDurationNs = readDuration("total_duration");
  const timing: OllamaProviderTiming = {
    ...(loadDurationNs !== undefined ? { loadDurationNs } : {}),
    ...(promptEvalDurationNs !== undefined ? { promptEvalDurationNs } : {}),
    ...(evalDurationNs !== undefined ? { evalDurationNs } : {}),
    ...(totalDurationNs !== undefined ? { totalDurationNs } : {}),
  };
  return Object.keys(timing).length > 0 ? timing : undefined;
}

export function writeGatewayEvents(
  events: ModelProviderEventSink,
  json: unknown,
  options: OllamaStreamOptions = {},
): void {
  const timing = readOllamaProviderTiming(json);
  if (timing) {
    options.onTerminalTiming?.(timing);
  }
  for (const event of readOllamaEvent(json)) {
    observeNormalizedEvent(options, event);
    events.emit(event);
  }
}

export function flushNdjsonBuffer(
  buffer: string,
  events: ModelProviderEventSink,
  options: OllamaStreamOptions = {},
): string {
  let remaining = buffer;
  let newlineIndex: number;

  while ((newlineIndex = remaining.indexOf("\n")) !== -1) {
    const line = remaining.slice(0, newlineIndex).trim();
    remaining = remaining.slice(newlineIndex + 1);

    if (!line) {
      continue;
    }

    try {
      writeGatewayEvents(events, JSON.parse(line), options);
    } catch {
      // Keep bridge behavior: ignore malformed upstream chunks.
    }
  }

  return remaining;
}

export async function forwardOllamaStream(
  body: ReadableStream<Uint8Array>,
  events: ModelProviderEventSink,
  options: OllamaStreamOptions = {},
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      buffer += decoder.decode();
    } else {
      buffer += decoder.decode(value, { stream: true });
    }

    buffer = flushNdjsonBuffer(buffer, events, options);

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    try {
      writeGatewayEvents(events, JSON.parse(buffer.trim()), options);
    } catch {
      // Keep bridge behavior: ignore malformed trailing chunks.
    }
  }
}

export async function collectOllamaStream(
  body: ReadableStream<Uint8Array>,
  options: OllamaStreamOptions = {},
): Promise<{
  text: string;
  thinking: string;
  usage?: ModelTokenUsage;
  doneReason?: string | null;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let thinking = "";
  let usage: ModelTokenUsage | undefined;
  let doneReason: string | null | undefined;

  const appendJson = (json: unknown) => {
    const obj =
      json && typeof json === "object"
        ? (json as {
            message?: { thinking?: unknown; content?: unknown };
            done?: unknown;
            done_reason?: unknown;
          })
        : {};
    const nextThinking = obj.message?.thinking;
    const nextContent = obj.message?.content;
    const nextUsage = readOllamaUsage(json);
    const timing = readOllamaProviderTiming(json);
    if (typeof nextThinking === "string" && nextThinking.length > 0) {
      thinking += nextThinking;
    }
    if (typeof nextContent === "string" && nextContent.length > 0) {
      text += nextContent;
    }
    if (nextUsage) {
      usage = nextUsage;
    }
    if (obj.done === true) {
      doneReason = typeof obj.done_reason === "string" ? obj.done_reason : null;
    }
    if (timing) {
      options.onTerminalTiming?.(timing);
    }
    for (const event of readOllamaEvent(json)) {
      observeNormalizedEvent(options, event);
    }
  };

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      buffer += decoder.decode();
    } else {
      buffer += decoder.decode(value, { stream: true });
    }

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      try {
        appendJson(JSON.parse(line));
      } catch {
        // Keep bridge behavior: ignore malformed upstream chunks.
      }
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    try {
      appendJson(JSON.parse(buffer.trim()));
    } catch {
      // Keep bridge behavior: ignore malformed trailing chunks.
    }
  }

  return {
    text,
    thinking,
    ...(usage ? { usage } : {}),
    ...(doneReason !== undefined ? { doneReason } : {}),
  };
}
