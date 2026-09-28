import { sanitizeJsonText } from "../../../src/plugin-sdk/index.js";
import type { ExecStreamSnapshot } from "./types.js";

export class CappedTextBuffer {
  private text = "";
  private originalChars = 0;
  private omittedChars = 0;
  private sawOutput = false;

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    if (!chunk) return;
    const safeChunk = sanitizeJsonText(chunk);
    this.sawOutput = true;
    this.originalChars += safeChunk.length;
    const available = Math.max(this.maxChars - this.text.length, 0);
    this.text += safeChunk.slice(0, available);
    this.omittedChars += Math.max(safeChunk.length - available, 0);
  }

  peek(): ExecStreamSnapshot {
    const text = this.text;
    const originalChars = this.originalChars;
    const omittedChars = this.omittedChars;
    return Object.freeze({
      text,
      sawOutput: this.sawOutput,
      metadata: Object.freeze({
        truncated: omittedChars > 0,
        originalChars,
        returnedChars: text.length,
        omittedChars,
      }),
    });
  }
  consume(): ExecStreamSnapshot {
    const result = this.peek();
    this.text = "";
    this.originalChars = 0;
    this.omittedChars = 0;
    return result;
  }
}
