type MessagePhase = "commentary" | "final_answer";

type MessageOutput = {
  itemId: string | null;
  outputIndex: number | null;
  arrivalOrder: number;
  textByteCount: number;
  phase?: MessagePhase;
  pending: { sequence: number; text: string }[];
};

type OutputDiagnostic = Readonly<{
  itemId: string | null;
  outputIndex: number | null;
  arrivalOrder: number;
  textByteCount: number;
  phase?: MessagePhase;
}>;

export type OpenAIMessageOutputNormalizationDiagnostic = Readonly<{
  outcome: "additional_message_outputs_ignored";
  outputCount: number;
  selectedOutput: OutputDiagnostic;
  ignoredOutputCount: number;
  sampledIgnoredOutputs: readonly OutputDiagnostic[];
  omittedIgnoredOutputCount: number;
}>;

const IGNORED_OUTPUT_DIAGNOSTIC_LIMIT = 8;

function readRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readMessagePhase(value: unknown): MessagePhase | undefined {
  if (value === "commentary" || value === "final_answer") return value;
  return undefined;
}

function readOutputIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function takePendingText(output: MessageOutput): string[] {
  const pending = output.pending;
  output.pending = [];
  return pending.map((chunk) => chunk.text);
}

function describeOutput(output: MessageOutput): OutputDiagnostic {
  return {
    itemId: output.itemId?.slice(0, 160) ?? null,
    outputIndex: output.outputIndex,
    arrivalOrder: output.arrivalOrder,
    textByteCount: output.textByteCount,
    ...(output.phase ? { phase: output.phase } : {}),
  };
}

/** One invocation's structured result; never infer its phase from generated text. */
export class OpenAIStructuredMessageOutput {
  private readonly outputs: MessageOutput[] = [];
  private readonly byItemId = new Map<string, MessageOutput>();
  private readonly byOutputIndex = new Map<number, MessageOutput>();
  private unidentifiedOutput: MessageOutput | undefined;
  private firstTextOutput: MessageOutput | undefined;
  private selectedOutput: MessageOutput | undefined;
  private hasExplicitPhase = false;
  private nextOutputOrder = 0;
  private nextChunkSequence = 0;

  observeItem(event: Record<string, unknown>): string[] {
    const item = readRecord(event.item);
    if (item.type !== "message") return [];
    const output = this.resolveOutput(item.id, event.output_index);
    const phase = readMessagePhase(item.phase);
    if (!phase) return this.takeSelectedText(output);

    this.hasExplicitPhase = true;
    output.phase = phase;
    if (phase === "commentary") {
      output.pending = [];
      return [];
    }
    this.selectFinalOutput(output);
    return this.takeSelectedText(output);
  }

  observeResponse(value: unknown): string[] {
    const response = readRecord(value);
    if (!Array.isArray(response.output)) return [];
    return response.output.flatMap((item, outputIndex) =>
      this.observeItem({ item, output_index: outputIndex }),
    );
  }

  consumeDelta(event: Record<string, unknown>, text: string): string[] {
    const output = this.resolveOutput(event.item_id, event.output_index);
    this.firstTextOutput ??= output;
    output.textByteCount += Buffer.byteLength(text, "utf8");
    if (output.phase === "commentary") return [];
    output.pending.push({ sequence: this.nextChunkSequence++, text });
    return this.takeSelectedText(output);
  }

  finish(): { text: string[]; error?: string } {
    if (this.selectedOutput) {
      return { text: takePendingText(this.selectedOutput) };
    }
    if (this.hasExplicitPhase) {
      return { text: [], error: "openai structured response missing final_answer" };
    }
    // Older responses have no phase: retain the first text message, never join them.
    this.selectedOutput = this.firstTextOutput;
    return {
      text: this.selectedOutput ? takePendingText(this.selectedOutput) : [],
    };
  }

  diagnostic(): OpenAIMessageOutputNormalizationDiagnostic | undefined {
    if (!this.selectedOutput || this.outputs.length < 2) return undefined;
    const ignored = this.outputs.filter((output) => output !== this.selectedOutput);
    return {
      outcome: "additional_message_outputs_ignored",
      outputCount: this.outputs.length,
      selectedOutput: describeOutput(this.selectedOutput),
      ignoredOutputCount: ignored.length,
      sampledIgnoredOutputs: ignored.slice(0, IGNORED_OUTPUT_DIAGNOSTIC_LIMIT).map(describeOutput),
      omittedIgnoredOutputCount: Math.max(0, ignored.length - IGNORED_OUTPUT_DIAGNOSTIC_LIMIT),
    };
  }

  private selectFinalOutput(output: MessageOutput): void {
    if (this.selectedOutput) return;
    this.selectedOutput = output;
  }

  private takeSelectedText(output: MessageOutput): string[] {
    if (output !== this.selectedOutput) return [];
    // Keep partial identities buffered until both identifiers can join their chunks.
    if (output.itemId === null) return [];
    if (output.outputIndex === null) return [];
    return takePendingText(output);
  }

  private mergeOutputs(first: MessageOutput, second: MessageOutput): MessageOutput {
    const [output, absorbed] = [first, second].sort((a, b) => a.arrivalOrder - b.arrivalOrder);
    output.itemId ??= absorbed.itemId;
    output.outputIndex ??= absorbed.outputIndex;
    output.phase ??= absorbed.phase;
    output.textByteCount += absorbed.textByteCount;
    output.pending = [...output.pending, ...absorbed.pending]
      .sort((a, b) => a.sequence - b.sequence);
    this.outputs.splice(this.outputs.indexOf(absorbed), 1);
    for (const [key, value] of this.byItemId) {
      if (value === absorbed) this.byItemId.set(key, output);
    }
    for (const [key, value] of this.byOutputIndex) {
      if (value === absorbed) this.byOutputIndex.set(key, output);
    }
    if (this.firstTextOutput === absorbed) this.firstTextOutput = output;
    if (this.selectedOutput === absorbed) this.selectedOutput = output;
    return output;
  }

  private reconcileOutputs(
    itemOutput?: MessageOutput,
    indexedOutput?: MessageOutput,
  ): MessageOutput | undefined {
    if (!itemOutput) return indexedOutput;
    if (!indexedOutput) return itemOutput;
    if (itemOutput === indexedOutput) return itemOutput;
    return this.mergeOutputs(itemOutput, indexedOutput);
  }

  private resolveOutput(itemIdValue: unknown, outputIndexValue: unknown): MessageOutput {
    const itemId = typeof itemIdValue === "string" && itemIdValue.length > 0
      ? itemIdValue : null;
    const outputIndex = readOutputIndex(outputIndexValue);
    const itemOutput = itemId === null ? undefined : this.byItemId.get(itemId);
    const indexedOutput = outputIndex === null ? undefined : this.byOutputIndex.get(outputIndex);
    let output = this.reconcileOutputs(itemOutput, indexedOutput);
    if (itemId === null && outputIndex === null) output = this.unidentifiedOutput;
    if (!output) {
      output = { itemId, outputIndex, arrivalOrder: ++this.nextOutputOrder,
        textByteCount: 0, pending: [] };
      this.outputs.push(output);
    }
    if (itemId !== null) {
      output.itemId = itemId;
      this.byItemId.set(itemId, output);
    }
    if (outputIndex !== null) {
      output.outputIndex = outputIndex;
      this.byOutputIndex.set(outputIndex, output);
    }
    if (itemId === null && outputIndex === null) this.unidentifiedOutput = output;
    return output;
  }
}
