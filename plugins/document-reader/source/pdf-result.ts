import { MAX_PDF_ERROR_MESSAGE_CHARS } from "./constants.js";
import { DocumentReaderError } from "./errors.js";
import type { PdfExtractionLimits, PdfWorkerMessage } from "./pdf-contract.js";
import type { ExtractedDocument } from "./types.js";

const CONTROLLED_PDF_ERROR_CODES = new Set([
  "document_content_invalid",
  "document_pdf_page_limit",
  "document_pdf_resource_limit",
]);

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isPdfWorkerMessage(value: unknown): value is PdfWorkerMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PdfWorkerMessage>;
  if (candidate.kind === "failure") {
    return (
      typeof candidate.message === "string" &&
      candidate.message.length <= MAX_PDF_ERROR_MESSAGE_CHARS &&
      (candidate.code === undefined || typeof candidate.code === "string")
    );
  }
  return (
    candidate.kind === "success" &&
    typeof candidate.text === "string" &&
    isSafeNonNegativeInteger(candidate.totalCharacters) &&
    isSafeNonNegativeInteger(candidate.returnedCharacters) &&
    isSafeNonNegativeInteger(candidate.totalPages) &&
    isSafeNonNegativeInteger(candidate.processedPages)
  );
}

function isBoundedPdfSuccess(
  message: Extract<PdfWorkerMessage, { kind: "success" }>,
  limits: PdfExtractionLimits,
): boolean {
  if (message.text.length !== message.returnedCharacters) return false;
  if (message.returnedCharacters > limits.maxRetainedCharacters) return false;
  if (message.returnedCharacters > message.totalCharacters) return false;
  if (message.totalPages > limits.maxPages) return false;
  return message.processedPages === message.totalPages;
}

export function documentFromPdfMessage(
  message: unknown,
  limits: PdfExtractionLimits,
): ExtractedDocument {
  if (!isPdfWorkerMessage(message)) {
    throw new Error("PDF extraction worker returned invalid data.");
  }
  if (message.kind === "failure") {
    if (message.code && CONTROLLED_PDF_ERROR_CODES.has(message.code)) {
      throw new DocumentReaderError(message.code, message.message);
    }
    throw new Error(message.message);
  }
  if (!isBoundedPdfSuccess(message, limits)) {
    throw new Error("PDF extraction worker exceeded its contract.");
  }
  return Object.freeze({
    text: message.text,
    textBounds: Object.freeze({
      truncated: message.totalCharacters > message.returnedCharacters,
      totalCharacters: message.totalCharacters,
      returnedCharacters: message.returnedCharacters,
      omittedCharacters: message.totalCharacters - message.returnedCharacters,
      maxCharacters: limits.maxRetainedCharacters,
    }),
    format: Object.freeze({
      kind: "pdf",
      totalPages: message.totalPages,
      processedPages: message.processedPages,
      maxPages: limits.maxPages,
    }),
  });
}
