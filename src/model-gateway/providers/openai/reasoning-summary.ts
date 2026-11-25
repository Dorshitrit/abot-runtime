import { createHash, type Hash } from "node:crypto";

type SummaryPart = {
  characters: number;
  digest: Hash;
  closed: boolean;
};

function readRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isSummaryIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readSummaryIdentity(event: Record<string, unknown>): string | undefined {
  if (typeof event.item_id !== "string" || !event.item_id) return undefined;
  if (!isSummaryIndex(event.output_index)) return undefined;
  if (!isSummaryIndex(event.summary_index)) return undefined;
  return JSON.stringify([event.item_id, event.output_index, event.summary_index]);
}

function matchesStreamedSummaryPrefix(part: SummaryPart, text: string): boolean {
  if (text.length < part.characters) return false;
  const prefix = createHash("sha256").update(text.slice(0, part.characters), "utf16le").digest("hex");
  return prefix === part.digest.copy().digest("hex");
}

/** Presentation only. Keep constant-size state per part, never a second text transcript. */
export class OpenAIReasoningSummary {
  private readonly parts = new Map<string, SummaryPart>();
  private lastSequence = -1;
  private emittedText = false;

  consume(event: Record<string, unknown>): string[] {
    if (event.type === "response.reasoning_summary_text.delta") return this.consumeDelta(event);
    if (event.type === "response.reasoning_summary_text.done") return this.consumeSnapshot(event, event.text);
    if (event.type === "response.reasoning_summary_part.done") {
      const part = readRecord(event.part);
      if (part.type !== "summary_text") return [];
      return this.consumeSnapshot(event, part.text);
    }
    if (event.type === "response.output_item.done") return this.consumeItem(event.item, event.output_index);
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      const response = readRecord(event.response);
      if (!Array.isArray(response.output)) return [];
      return response.output.flatMap((item, index) => this.consumeItem(item, index));
    }
    return [];
  }

  clear(): void {
    this.parts.clear();
  }

  private consumeItem(value: unknown, outputIndex: unknown): string[] {
    const item = readRecord(value);
    if (item.type !== "reasoning" || !Array.isArray(item.summary)) return [];
    return item.summary.flatMap((value, summaryIndex) => {
      const part = readRecord(value);
      if (part.type !== "summary_text") return [];
      return this.consumeSnapshot({ item_id: item.id, output_index: outputIndex, summary_index: summaryIndex }, part.text);
    });
  }

  private resolvePart(identity: string): SummaryPart {
    const existing = this.parts.get(identity);
    if (existing) return existing;
    const part = { characters: 0, digest: createHash("sha256"), closed: false };
    this.parts.set(identity, part);
    return part;
  }

  private consumeDelta(event: Record<string, unknown>): string[] {
    const identity = readSummaryIdentity(event);
    if (!identity || typeof event.delta !== "string" || !event.delta) return [];
    // SSE is ordered; the cursor rejects replay without retaining every sequence number.
    if (!isSummaryIndex(event.sequence_number)) return [];
    if (event.sequence_number <= this.lastSequence) return [];
    this.lastSequence = event.sequence_number;
    const part = this.resolvePart(identity);
    if (part.closed) return [];
    return this.emit(part, event.delta);
  }

  private consumeSnapshot(event: Record<string, unknown>, value: unknown): string[] {
    const identity = readSummaryIdentity(event);
    if (!identity || typeof value !== "string") return [];
    const part = this.resolvePart(identity);
    if (part.closed) return [];
    // A conflicting optional summary must never corrupt the answer or replace streamed text.
    if (!matchesStreamedSummaryPrefix(part, value)) return [];
    const suffix = value.slice(part.characters);
    const output = this.emit(part, suffix);
    part.closed = true;
    return output;
  }

  private emit(part: SummaryPart, text: string): string[] {
    if (!text) return [];
    const separator = part.characters === 0 && this.emittedText ? "\n\n" : "";
    part.characters += text.length;
    // UTF-16 keeps hashing stable even if a provider splits a surrogate pair across deltas.
    part.digest.update(text, "utf16le");
    this.emittedText = true;
    return [separator + text];
  }
}
