/** Byte-only document extraction. No installed plugin or Runtime service is loaded. */
export { extractDocxText, extractPptxText, extractXlsxText } from "../shared/document-text/ooxml.js";
export { BoundedTextAccumulator, normalizeExtractedText } from "../shared/document-text/text-accumulator.js";
export { DocumentTextError } from "../shared/document-text/errors.js";
export type { ArchiveExtractionMetadata, ExtractedDocument, FormatExtractionMetadata } from "../shared/document-text/contracts.js";
