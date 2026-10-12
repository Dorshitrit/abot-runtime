import { readOpenAIFunctionResult } from "./function-result.js";
import { buildModelTokenUsage } from "../../protocol/usage.js";
import type { ModelTokenUsage } from "../../types.js";
import type { ModelProviderEventSink } from "../contracts.js";

import {
  OpenAIStructuredMessageOutput,
  type OpenAIMessageOutputNormalizationDiagnostic,
} from "./structured-message-output.js";

export type { OpenAIMessageOutputNormalizationDiagnostic } from "./structured-message-output.js";

export type OpenAIResponsesStreamOptions = Readonly<{
  structuredOutput?: boolean;
  functionOutputName?: string;
  onMessageOutputDiagnostic?: (
    diagnostic: OpenAIMessageOutputNormalizationDiagnostic,
  ) => void;
}>;

export type NormalizedOpenAIStreamEvent =
  | { type: "content"; text: string }
  | {
      type: "done";
      done: true;
      usage?: ModelTokenUsage;
      doneReason?: string;
    }
  | { type: "error"; error: string };

function readRecord(value: unknown): Record<string, unknown> {
  const isRecord =
    value !== null && typeof value === "object" && !Array.isArray(value);
  return isRecord ? (value as Record<string, unknown>) : {};
}

function readOpenAIUsage(data: unknown): ModelTokenUsage | undefined {
  const event = readRecord(data);
  const response = readRecord(event.response);
  const usage = readRecord(response.usage);
  const inputDetails = readRecord(usage.input_tokens_details);
  const outputDetails = readRecord(usage.output_tokens_details);
  return buildModelTokenUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: inputDetails.cached_tokens,
    reasoningTokens: outputDetails.reasoning_tokens,
  });
}

function readOpenAIError(data: unknown): string {
  const event = readRecord(data);
  const error = readRecord(event.error);
  return (
    (typeof error.message === "string" && error.message.trim()) ||
    (typeof event.message === "string" && event.message.trim()) ||
    "openai stream error"
  );
}

function readOpenAIIncompleteReason(data: unknown): string {
  const event = readRecord(data);
  const response = readRecord(event.response);
  const incompleteDetails = readRecord(response.incomplete_details);
  const reason = incompleteDetails.reason;
  return typeof reason === "string" && reason.trim().length > 0
    ? reason.trim()
    : "unknown_reason";
}

function isMessageItemEvent(event: Record<string, unknown>): boolean {
  return event.type === "response.output_item.added" || event.type === "response.output_item.done";
}

function contentEvents(texts: readonly string[]): NormalizedOpenAIStreamEvent[] {
  return texts.map((text) => ({ type: "content", text }));
}

function isStreamError(event: NormalizedOpenAIStreamEvent): boolean {
  return event.type === "error";
}

export class OpenAIResponsesStreamNormalizer {
  private readonly structuredOutput = new OpenAIStructuredMessageOutput();
  private terminal = false;

  constructor(private readonly options: OpenAIResponsesStreamOptions) {}

  get hasTerminated(): boolean {
    return this.terminal;
  }

  consume(data: unknown): NormalizedOpenAIStreamEvent[] {
    if (this.terminal) {
      return [];
    }
    const event = readRecord(data);
    const isFailedResponse = event.type === "response.failed";
    if (isFailedResponse) {
      return this.fail(readOpenAIError(event.response));
    }
    if (event.type === "response.output_text.delta") {
      return this.consumeTextDelta(event);
    }
    if (isMessageItemEvent(event)) {
      return this.consumeMessageItem(event);
    }
    if (event.type === "response.completed") {
      return this.complete(readOpenAIUsage(data), undefined, event.response);
    }
    if (event.type === "response.incomplete") {
      return this.consumeIncompleteResponse(data);
    }
    if (event.type === "error") {
      this.terminal = true;
      return [{ type: "error", error: readOpenAIError(data) }];
    }
    return [];
  }

  finish(): NormalizedOpenAIStreamEvent[] {
    const events = this.end();
    if (this.terminal) return events;
    return this.complete(undefined);
  }

  private consumeTextDelta(
    event: Record<string, unknown>,
  ): NormalizedOpenAIStreamEvent[] {
    if (this.options.functionOutputName) return [];
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) {
      return [];
    }
    if (!this.options.structuredOutput) {
      return [{ type: "content", text: delta }];
    }

    return contentEvents(this.structuredOutput.consumeDelta(event, delta));
  }

  private consumeIncompleteResponse(
    data: unknown,
  ): NormalizedOpenAIStreamEvent[] {
    const reason = readOpenAIIncompleteReason(data);
    if (!this.options.functionOutputName && reason === "max_output_tokens") {
      return this.complete(readOpenAIUsage(data), reason, readRecord(data).response);
    }
    this.terminal = true;
    return [{ type: "error", error: `openai response incomplete: ${reason}` }];
  }

  private consumeMessageItem(event: Record<string, unknown>): NormalizedOpenAIStreamEvent[] {
    if (this.options.functionOutputName) return [];
    if (!this.options.structuredOutput) return [];
    return contentEvents(this.structuredOutput.observeItem(event));
  }

  // Transport endings cannot authorize decisions or payloads. Ordinary text
  // retains its legacy partial-output behavior.
  end(): NormalizedOpenAIStreamEvent[] {
    if (this.terminal) return [];
    if (this.options.functionOutputName) return this.fail("openai function response not completed");
    const requiresCompletedMessage = this.options.structuredOutput === true;
    if (requiresCompletedMessage) return this.fail("openai response not completed");
    return [];
  }

  private finishStructuredOutput(response?: unknown): NormalizedOpenAIStreamEvent[] {
    if (!this.options.structuredOutput) return [];
    const pending = this.structuredOutput.observeResponse(response);
    const result = this.structuredOutput.finish();
    if (result.error) return [{ type: "error", error: result.error }];
    const diagnostic = this.structuredOutput.diagnostic();
    if (diagnostic) this.options.onMessageOutputDiagnostic?.(diagnostic);
    return contentEvents([...pending, ...result.text]);
  }

  private fail(error: string): NormalizedOpenAIStreamEvent[] {
    this.terminal = true;
    return [{ type: "error", error }];
  }

  private finishFunctionOutput(response: unknown, name: string): NormalizedOpenAIStreamEvent[] {
    const result = readOpenAIFunctionResult(response, name);
    if ("error" in result) return [{ type: "error", error: result.error }];
    return [{ type: "content", text: result.text }];
  }

  private complete(
    usage: ModelTokenUsage | undefined,
    doneReason?: string,
    response?: unknown,
  ): NormalizedOpenAIStreamEvent[] {
    if (this.terminal) {
      return [];
    }
    const pending = this.options.functionOutputName
      ? this.finishFunctionOutput(response, this.options.functionOutputName)
      : this.finishStructuredOutput(response);
    this.terminal = true;
    if (pending.some(isStreamError)) return pending;
    return [
      ...pending,
      {
        type: "done",
        done: true,
        ...(usage ? { usage } : {}),
        ...(doneReason ? { doneReason } : {}),
      },
    ];
  }

}

export function writeNormalizedOpenAIEvents(
  events: readonly NormalizedOpenAIStreamEvent[],
  sink: ModelProviderEventSink,
): void {
  for (const event of events) {
    sink.emit(
      event.type === "done"
        ? { ...event, doneReason: event.doneReason ?? null }
        : event,
    );
  }
}
