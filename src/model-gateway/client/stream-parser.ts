import type { ModelTokenUsage } from "../types.js";
import { normalizeModelTokenUsage } from "../protocol/usage.js";

export type StreamCallbacks = {
  onThinking?: (text: string) => void;
  onToken?: (text: string) => void;
  onUsage?: (usage: ModelTokenUsage) => void;
  onTerminal?: (terminal: { providerCompletionReason: string | null }) => void;
  onStreamEvent?: (event: {
    kind:
      | "thinking"
      | "content"
      | "content_empty"
      | "error"
      | "invalid_json"
      | "unknown_type";
    text?: string;
    raw?: string;
    type?: string;
  }) => void;
};

type ParsedStreamEvent = {
  type?: unknown;
  stream?: unknown;
  text?: unknown;
  delta?: unknown;
  data?: unknown;
  error?: unknown;
  message?: unknown;
  usage?: unknown;
  doneReason?: unknown;
};

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseStreamEvent(
  line: string,
  callbacks: StreamCallbacks,
): ParsedStreamEvent | undefined {
  try {
    return JSON.parse(line) as ParsedStreamEvent;
  } catch {
    callbacks.onStreamEvent?.({
      kind: "invalid_json",
      raw: line.slice(0, 300),
    });
    return undefined;
  }
}

function emitContent(
  token: string,
  callbacks: StreamCallbacks,
  currentText: string,
): string {
  if (token) {
    callbacks.onToken?.(token);
    callbacks.onStreamEvent?.({
      kind: "content",
      text: token,
    });
    return currentText + token;
  }
  callbacks.onStreamEvent?.({
    kind: "content_empty",
  });
  return currentText;
}

function isErrorEvent(messageType: string, stream: string): boolean {
  return messageType === "error" || stream === "error";
}

function readErrorMessage(
  message: ParsedStreamEvent,
  data: Record<string, unknown>,
): string {
  const errorObject = readObject(message.error);
  return (
    readText(message.error) ||
    readText(errorObject.message) ||
    readText(message.message) ||
    readText(data.error) ||
    readText(data.message) ||
    "model stream error"
  );
}

function throwStreamError(
  message: ParsedStreamEvent,
  data: Record<string, unknown>,
  callbacks: StreamCallbacks,
): never {
  const errorText = readErrorMessage(message, data);
  callbacks.onStreamEvent?.({
    kind: "error",
    text: errorText,
  });
  throw new Error(`model_stream_error: ${errorText}`);
}

function readContentText(
  message: ParsedStreamEvent,
  data: Record<string, unknown>,
): string {
  return (
    readText(message.text) ||
    readText(message.delta) ||
    readText(data.delta) ||
    readText(data.text)
  );
}

function emitThinking(
  thinkingText: string,
  callbacks: StreamCallbacks,
  currentText: string,
): string {
  if (thinkingText) {
    callbacks.onThinking?.(thinkingText);
  }
  callbacks.onStreamEvent?.({
    kind: "thinking",
    text: thinkingText,
  });
  return currentText;
}

function emitTerminal(
  message: ParsedStreamEvent,
  callbacks: StreamCallbacks,
): void {
  const usage = normalizeModelTokenUsage(message.usage);
  if (usage) {
    callbacks.onUsage?.(usage);
  }
  callbacks.onTerminal?.({
    providerCompletionReason:
      typeof message.doneReason === "string"
        ? message.doneReason.slice(0, 160)
        : null,
  });
}

function isThinkingEvent(messageType: string, stream: string): boolean {
  return messageType === "thinking" || stream === "thinking";
}

function isContentEvent(messageType: string): boolean {
  return (
    messageType === "content" ||
    messageType === "final" ||
    messageType === "done"
  );
}

function readAssistantStreamContent(
  message: ParsedStreamEvent,
  data: Record<string, unknown>,
): string {
  return (
    readText(data.delta) ||
    readText(data.text) ||
    readText(message.text) ||
    readText(message.delta)
  );
}

export function applyStreamLine(
  line: string,
  callbacks: StreamCallbacks,
  currentText: string,
): string {
  if (!line.trim()) {
    return currentText;
  }

  const message = parseStreamEvent(line, callbacks);
  if (!message) {
    return currentText;
  }

  const messageType = typeof message.type === "string" ? message.type : "";
  const stream = typeof message.stream === "string" ? message.stream : "";
  const data = readObject(message.data);

  if (isErrorEvent(messageType, stream)) {
    return throwStreamError(message, data, callbacks);
  }

  const contentText = readContentText(message, data);
  if (isThinkingEvent(messageType, stream)) {
    return emitThinking(contentText, callbacks, currentText);
  }

  if (messageType === "done") {
    emitTerminal(message, callbacks);
  }

  if (isContentEvent(messageType)) {
    return emitContent(contentText, callbacks, currentText);
  }

  if (stream === "assistant") {
    return emitContent(
      readAssistantStreamContent(message, data),
      callbacks,
      currentText,
    );
  }

  callbacks.onStreamEvent?.({
    kind: "unknown_type",
    type: messageType || stream || "missing",
  });
  return currentText;
}
