import {
  MAX_PDF_PAGES,
  MAX_RETAINED_TEXT_CHARS,
  PDF_EXTRACTION_TIMEOUT_MS,
  PDF_MAX_OLD_GENERATION_MB,
  PDF_MAX_STACK_MB,
  PDF_MAX_YOUNG_GENERATION_MB,
  PDF_PAGE_BATCH_SIZE,
} from "./constants.js";

export type PdfExtractionLimits = Readonly<{
  maxPages: number;
  pageBatchSize: number;
  maxRetainedCharacters: number;
  timeoutMs: number;
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
}>;

export const PDF_EXTRACTION_LIMITS: PdfExtractionLimits = Object.freeze({
  maxPages: MAX_PDF_PAGES,
  pageBatchSize: PDF_PAGE_BATCH_SIZE,
  maxRetainedCharacters: MAX_RETAINED_TEXT_CHARS,
  timeoutMs: PDF_EXTRACTION_TIMEOUT_MS,
  maxOldGenerationSizeMb: PDF_MAX_OLD_GENERATION_MB,
  maxYoungGenerationSizeMb: PDF_MAX_YOUNG_GENERATION_MB,
  stackSizeMb: PDF_MAX_STACK_MB,
});

type PdfWorkerSuccess = Readonly<{
  kind: "success";
  text: string;
  totalCharacters: number;
  returnedCharacters: number;
  totalPages: number;
  processedPages: number;
}>;

type PdfWorkerFailure = Readonly<{
  kind: "failure";
  code?: string;
  message: string;
}>;

export type PdfWorkerMessage = PdfWorkerSuccess | PdfWorkerFailure;

export type PdfParserInput = Readonly<{
  bytes: ArrayBuffer | Uint8Array;
  pdfParseEntrypoint: string;
  limits: Readonly<{
    maxPages: number;
    pageBatchSize: number;
    maxRetainedCharacters: number;
    maxErrorMessageCharacters: number;
  }>;
}>;
