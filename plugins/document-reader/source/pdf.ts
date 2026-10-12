import { extractPdfInProcess } from "./pdf-process.js";
import { extractPdfInWorker } from "./pdf-worker.js";
import type { ExtractedDocument } from "./types.js";

export function extractPdfText(
  bytes: Uint8Array,
  pdfParseEntrypoint: string,
  signal?: AbortSignal,
): Promise<ExtractedDocument> {
  const extract =
    process.platform === "win32" ? extractPdfInProcess : extractPdfInWorker;
  return extract(bytes, {
    pdfParseEntrypoint,
    ...(signal ? { signal } : {}),
  });
}
