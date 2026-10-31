import type { ExtractedDocument, FormatExtractionMetadata } from "./contracts.js";

export function normalizeExtractedText(value: string): string {
  return value.replaceAll("\u0000", "").trim();
}

export class BoundedTextAccumulator {
  readonly #maxCharacters: number;
  readonly #parts: string[] = [];
  #returnedCharacters = 0;
  #totalCharacters = 0;
  #hasContent = false;

  constructor(maxCharacters: number) {
    this.#maxCharacters = maxCharacters;
  }

  append(value: string, separator: string = "\n\n"): void {
    if (value.length === 0) return;
    const combined = this.#hasContent ? separator + value : value;
    this.#hasContent = true;
    this.#totalCharacters += combined.length;
    const remaining = this.#maxCharacters - this.#returnedCharacters;
    if (remaining <= 0) return;
    const retained = combined.slice(0, remaining);
    this.#parts.push(retained);
    this.#returnedCharacters += retained.length;
  }

  finish(format: FormatExtractionMetadata): ExtractedDocument {
    return Object.freeze({
      text: this.#parts.join(""),
      textBounds: Object.freeze({
        truncated: this.#totalCharacters > this.#returnedCharacters,
        totalCharacters: this.#totalCharacters,
        returnedCharacters: this.#returnedCharacters,
        omittedCharacters: this.#totalCharacters - this.#returnedCharacters,
        maxCharacters: this.#maxCharacters,
      }),
      format,
    });
  }
}
