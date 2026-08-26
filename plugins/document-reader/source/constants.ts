export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_CHARS = 40_000;
export const MAX_START_CHAR = 10_000_000;
export const MAX_RETAINED_TEXT_CHARS = MAX_START_CHAR + MAX_CHARS;
export const MAX_OUTPUT_CHARS = 48_000;
export const MAX_OUTPUT_JSON_BYTES = 64 * 1024;
export const MAX_IDENTITY_CHARS = 512;

export const MAX_ARCHIVE_ENTRIES = 4_096;
export const MAX_ARCHIVE_DECLARED_BYTES = 256 * 1024 * 1024;
export const MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_XML_BYTES = 24 * 1024 * 1024;
export const MAX_PDF_PAGES = 10_000;
export const PDF_PAGE_BATCH_SIZE = 1;
export const PDF_EXTRACTION_TIMEOUT_MS = 30_000;
export const PDF_MAX_OLD_GENERATION_MB = 128;
export const PDF_MAX_YOUNG_GENERATION_MB = 16;
export const PDF_MAX_STACK_MB = 4;
export const MAX_PDF_ERROR_MESSAGE_CHARS = 512;

export const EXTENSION_MIME_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
  ".rtf": "application/rtf",
} as const);

export const MIME_TYPE_ALIASES = Object.freeze({
  "application/x-rtf": "application/rtf",
  "text/rtf": "application/rtf",
  "text/x-markdown": "text/markdown",
} as const);
