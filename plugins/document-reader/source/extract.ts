import { failDocument } from "./errors.js";
import { extractDocxText, extractPptxText, extractXlsxText } from "./ooxml.js";
import { extractPdfText } from "./pdf.js";
import { extractedTextResult } from "./text-accumulator.js";
import type { DocumentReference, ExtractedDocument } from "./types.js";

function extractRtfText(source: string): string {
  return source
    .replace(/\\'[0-9a-f]{2}/giu, (value) =>
      String.fromCharCode(Number.parseInt(value.slice(2), 16)),
    )
    .replace(/\\[a-z]+-?\d* ?/giu, "")
    .replace(/[{}]/gu, "");
}

export async function extractDocumentText(
  document: DocumentReference,
  bytes: Uint8Array,
  pdfParseEntrypoint: string,
  signal?: AbortSignal,
): Promise<ExtractedDocument> {
  switch (document.mimeType) {
    case "application/pdf":
      return extractPdfText(bytes, pdfParseEntrypoint, signal);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocxText(bytes, signal);
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return extractXlsxText(bytes, signal);
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return extractPptxText(bytes, signal);
    case "application/json": {
      try {
        const parsed = JSON.parse(
          Buffer.from(bytes).toString("utf8"),
        ) as unknown;
        return extractedTextResult(JSON.stringify(parsed, null, 2));
      } catch {
        failDocument(
          "document_content_invalid",
          "The requested JSON document is invalid.",
        );
      }
    }
    case "application/rtf":
      return extractedTextResult(
        extractRtfText(Buffer.from(bytes).toString("utf8")),
      );
    case "text/plain":
    case "text/csv":
    case "text/markdown":
      return extractedTextResult(Buffer.from(bytes).toString("utf8"));
  }
}
