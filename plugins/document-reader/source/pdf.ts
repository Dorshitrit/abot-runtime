import { extractPdfInWorker } from "./pdf-worker.js";
import type { ExtractedDocument } from "./types.js";

export function extractPdfText(
  bytes: Uint8Array,
  pdfParseEntrypoint: string,
  signal?: AbortSignal,
): Promise<ExtractedDocument> {
  return extractPdfInWorker(bytes, {
    pdfParseEntrypoint,
    ...(signal ? { signal } : {}),
  });
}
