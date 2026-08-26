import { buildModelTokenUsage } from "../../protocol/usage.js";
import type { ModelTokenUsage } from "../../types.js";
import type { ModelProviderEventSink } from "../contracts.js";

export type OpenAIMessageOutputNormalizationDiagnostic = Readonly<{
  outcome: "additional_message_outputs_ignored";
  outputCount: number;
  selectedOutput: Readonly<{
    itemId: string | null;
    outputIndex: number | null;
    arrivalOrder: number;
    textByteCount: number;
  }>;
  ignoredOutputCount: number;
  sampledIgnoredOutputs: readonly Readonly<{
    itemId: string | null;
    outputIndex: number | null;
    arrivalOrder: number;
    textByteCount: number;
  }>[];
  omittedIgnoredOutputCount: number;
}>;

export type OpenAIResponsesStreamOptions = Readonly<{
  structuredOutput?: boolean;
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

type OpenAIMessageOutputState = {
  key: string;
  itemId: string | null;
  outputIndex: number | null;
  arrivalOrder: number;
  textByteCount: number;
};

const OPENAI_IGNORED_MESSAGE_OUTPUT_DIAGNOSTIC_LIMIT = 8;

function readRecord(value: unknown): Record<string, unknown> {
  const isRecord =
    value !== null && typeof value === "object" && !Array.isArray(value);
  return isRecord ? (value as Record<string, unknown>) : {};
}

function resolveMessageOutputKey(params: {
  itemId: string | null;
  outputIndex: number | null;
}): string {
  if (params.itemId !== null) {
    return `item:${params.itemId}`;
  }
  if (params.outputIndex !== null) {
    return `output:${params.outputIndex}`;
  }
  return "unidentified-message-output";
}

function readOpenAIMessageOutputIdentity(
  event: Record<string, unknown>,
): Pick<OpenAIMessageOutputState, "key" | "itemId" | "outputIndex"> {
  const itemId =
    typeof event.item_id === "string" && event.item_id.length > 0
      ? event.item_id
      : null;
  const outputIndex =
    typeof event.output_index === "number" &&
    Number.isInteger(event.output_index) &&
    event.output_index >= 0
      ? event.output_index
      : null;
  return {
    key: resolveMessageOutputKey({ itemId, outputIndex }),
    itemId,
    outputIndex,
  };
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

export class OpenAIResponsesStreamNormalizer {
  private readonly outputs = new Map<string, OpenAIMessageOutputState>();
  private primaryOutputKey: string | undefined;
  private terminal = false;

  constructor(private readonly options: OpenAIResponsesStreamOptions) {}

  consume(data: unknown): NormalizedOpenAIStreamEvent[] {
    if (this.terminal) {
      return [];
    }
    const event = readRecord(data);
    if (event.type === "response.output_text.delta") {
      return this.consumeTextDelta(event);
    }
    if (event.type === "response.completed") {
      return this.complete(readOpenAIUsage(data));
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
    return this.complete(undefined);
  }

  private consumeTextDelta(
    event: Record<string, unknown>,
  ): NormalizedOpenAIStreamEvent[] {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) {
      return [];
    }
    if (!this.options.structuredOutput) {
      return [{ type: "content", text: delta }];
    }

    const output = this.getMessageOutput(event);
    output.textByteCount += Buffer.byteLength(delta, "utf8");
    return output.key === this.primaryOutputKey
      ? [{ type: "content", text: delta }]
      : [];
  }

  private consumeIncompleteResponse(
    data: unknown,
  ): NormalizedOpenAIStreamEvent[] {
    const reason = readOpenAIIncompleteReason(data);
    if (reason === "max_output_tokens") {
      return this.complete(readOpenAIUsage(data), reason);
    }
    this.terminal = true;
    return [{ type: "error", error: `openai response incomplete: ${reason}` }];
  }

  private getMessageOutput(
    event: Record<string, unknown>,
  ): OpenAIMessageOutputState {
    const identity = readOpenAIMessageOutputIdentity(event);
    let output = this.outputs.get(identity.key);
    if (!output) {
      output = {
        ...identity,
        arrivalOrder: this.outputs.size + 1,
        textByteCount: 0,
      };
      this.outputs.set(identity.key, output);
      this.primaryOutputKey ??= identity.key;
    }
    return output;
  }

  private complete(
    usage: ModelTokenUsage | undefined,
    doneReason?: string,
  ): NormalizedOpenAIStreamEvent[] {
    if (this.terminal) {
      return [];
    }
    this.emitAdditionalOutputDiagnostic();
    this.terminal = true;
    return [
      {
        type: "done",
        done: true,
        ...(usage ? { usage } : {}),
        ...(doneReason ? { doneReason } : {}),
      },
    ];
  }

  private emitAdditionalOutputDiagnostic(): void {
    const hasAdditionalStructuredOutputs =
      this.options.structuredOutput && this.outputs.size > 1;
    if (!hasAdditionalStructuredOutputs) {
      return;
    }

    const outputs = [...this.outputs.values()];
    const selectedOutput = outputs[0]!;
    const ignoredOutputs = outputs.slice(1);
    this.options.onMessageOutputDiagnostic?.({
      outcome: "additional_message_outputs_ignored",
      outputCount: outputs.length,
      selectedOutput: {
        itemId: selectedOutput.itemId?.slice(0, 160) ?? null,
        outputIndex: selectedOutput.outputIndex,
        arrivalOrder: selectedOutput.arrivalOrder,
        textByteCount: selectedOutput.textByteCount,
      },
      ignoredOutputCount: ignoredOutputs.length,
      sampledIgnoredOutputs: ignoredOutputs
        .slice(0, OPENAI_IGNORED_MESSAGE_OUTPUT_DIAGNOSTIC_LIMIT)
        .map(({ itemId, outputIndex, arrivalOrder, textByteCount }) => ({
          itemId: itemId?.slice(0, 160) ?? null,
          outputIndex,
          arrivalOrder,
          textByteCount,
        })),
      omittedIgnoredOutputCount: Math.max(
        0,
        ignoredOutputs.length - OPENAI_IGNORED_MESSAGE_OUTPUT_DIAGNOSTIC_LIMIT,
      ),
    });
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
