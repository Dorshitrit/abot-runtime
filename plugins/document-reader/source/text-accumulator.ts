import { BoundedTextAccumulator, normalizeExtractedText } from "../../../src/plugin-sdk/document-text.js";
import { MAX_RETAINED_TEXT_CHARS } from "./constants.js";
import type { ExtractedDocument, FormatExtractionMetadata } from "./types.js";

export { normalizeExtractedText };

export function extractedTextResult(
  value: string,
  format: FormatExtractionMetadata = Object.freeze({ kind: "text" }),
): ExtractedDocument {
  const accumulator = new BoundedTextAccumulator(MAX_RETAINED_TEXT_CHARS);
  accumulator.append(normalizeExtractedText(value), "");
  return accumulator.finish(format);
}
