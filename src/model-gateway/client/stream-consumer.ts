import {
  applyStreamLine,
  type StreamCallbacks,
} from "../client-stream-parser.js";
import type { ModelTokenUsage } from "../types.js";
import type { EmptyResponseReason, StreamMeta } from "./contracts.js";

function resolveAbortMessage(reason?: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason;
  }
  return "aborted";
}

function createAbortError(reason?: unknown): Error {
  const message = resolveAbortMessage(reason);
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

type ByteStreamReader = Pick<
  ReadableStreamDefaultReader<Uint8Array>,
  "read" | "cancel"
>;

export class InactivityBoundStreamReader {
  constructor(
    private readonly reader: ByteStreamReader,
    private readonly abortSignal: AbortSignal,
    private readonly getInactivityTimeoutMs: () => number,
  ) {}

  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.abortSignal.aborted) {
      void this.reader.cancel(this.abortSignal.reason).catch(() => {});
      throw createAbortError(this.abortSignal.reason);
    }

    const inactivityTimeoutMs = this.getInactivityTimeoutMs();
    return await new Promise<ReadableStreamReadResult<Uint8Array>>(
      (resolve, reject) => {
        let settled = false;
        let inactivityHandle: ReturnType<typeof setTimeout> | undefined;
        const settle = (
          callback: typeof resolve | typeof reject,
          value: ReadableStreamReadResult<Uint8Array> | Error,
        ) => {
          if (settled) {
            return;
          }
          settled = true;
          if (inactivityHandle !== undefined) {
            clearTimeout(inactivityHandle);
            inactivityHandle = undefined;
          }
          this.abortSignal.removeEventListener("abort", onAbort);
          callback(value as never);
        };
        const onAbort = () => {
          void this.reader.cancel(this.abortSignal.reason).catch(() => {});
          settle(reject, createAbortError(this.abortSignal.reason));
        };

        this.abortSignal.addEventListener("abort", onAbort, { once: true });
        inactivityHandle = setTimeout(() => {
          void this.reader
            .cancel("llm_stream_inactivity_timeout")
            .catch(() => {});
          settle(reject, createAbortError("llm_stream_inactivity_timeout"));
        }, inactivityTimeoutMs);
        void this.reader.read().then(
          (result) => settle(resolve, result),
          (error) => settle(reject, error),
        );
      },
    );
  }
}

export class ChatStreamAccumulator {
  private readonly decoder = new TextDecoder();
  private readonly unknownTypeCounts: Record<string, number> = {};
  private fullText = "";
  private pendingText = "";
  private chunkCount = 0;
  private totalBytes = 0;
  private thinkingEvents = 0;
  private contentEvents = 0;
  private contentEmptyEvents = 0;
  private invalidJsonLines = 0;
  private terminalEventCount = 0;
  private completionReason: string | null | undefined;
  private usage: ModelTokenUsage | undefined;

  constructor(private readonly callbacks: StreamCallbacks) {}

  acceptChunk(value: Uint8Array): void {
    this.chunkCount += 1;
    this.totalBytes += value.byteLength;
    this.pendingText += this.decoder.decode(value, { stream: true });

    const lines = this.pendingText.split("\n");
    this.pendingText = lines.pop() || "";
    for (const line of lines) {
      this.applyLine(line);
    }
  }

  flushPending(): void {
    if (this.pendingText.trim()) {
      this.applyLine(this.pendingText);
    }
  }

  get text(): string {
    return this.fullText;
  }

  get providerUsage(): ModelTokenUsage | undefined {
    return this.usage;
  }

  get providerCompletionReason(): string | null | undefined {
    return this.completionReason;
  }

  toMeta(status: number): StreamMeta {
    return {
      status,
      chunkCount: this.chunkCount,
      totalBytes: this.totalBytes,
      thinkingEvents: this.thinkingEvents,
      contentEvents: this.contentEvents,
      contentEmptyEvents: this.contentEmptyEvents,
      invalidJsonLines: this.invalidJsonLines,
      unknownTypeCounts: this.unknownTypeCounts,
      outputLength: this.fullText.length,
      terminalEventCount: this.terminalEventCount,
      ...(this.completionReason !== undefined
        ? { providerCompletionReason: this.completionReason }
        : {}),
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  private applyLine(line: string): void {
    this.fullText = applyStreamLine(
      line,
      {
        ...this.callbacks,
        onUsage: (usage) => {
          this.usage = usage;
          this.callbacks.onUsage?.(usage);
        },
        onTerminal: (terminal) => {
          this.terminalEventCount += 1;
          const shouldReplaceCompletionReason =
            this.completionReason === undefined ||
            terminal.providerCompletionReason !== null;
          if (shouldReplaceCompletionReason) {
            this.completionReason = terminal.providerCompletionReason;
          }
          this.callbacks.onTerminal?.(terminal);
        },
        onStreamEvent: (event) => {
          if (event.kind === "thinking") this.thinkingEvents += 1;
          if (event.kind === "content") this.contentEvents += 1;
          if (event.kind === "content_empty") this.contentEmptyEvents += 1;
          if (event.kind === "invalid_json") this.invalidJsonLines += 1;
          if (event.kind === "unknown_type") {
            const key = event.type || "missing";
            this.unknownTypeCounts[key] =
              (this.unknownTypeCounts[key] || 0) + 1;
          }
        },
      },
      this.fullText,
    );
  }
}

function countUnknownStreamEvents(meta: StreamMeta): number {
  return Object.values(meta.unknownTypeCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
}

function isThinkingOnlyResponse(
  meta: StreamMeta,
  unknownEventCount: number,
): boolean {
  return (
    meta.thinkingEvents > 0 &&
    meta.contentEvents === 0 &&
    meta.invalidJsonLines === 0 &&
    unknownEventCount === 0
  );
}

export function classifyEmptyResponse(meta: StreamMeta): EmptyResponseReason {
  const unknownEventCount = countUnknownStreamEvents(meta);
  if (isThinkingOnlyResponse(meta, unknownEventCount)) {
    return "thinking_only_response";
  }
  if (meta.invalidJsonLines > 0) {
    return "parser_or_stream_assembly_failure";
  }
  if (unknownEventCount > 0) {
    return "unrecognized_stream_event_shape";
  }
  if (meta.contentEvents === 0 && meta.contentEmptyEvents > 0) {
    return "content_events_without_text";
  }
  if (meta.totalBytes === 0) {
    return "empty_stream_body";
  }
  return "unknown_empty_response";
}
