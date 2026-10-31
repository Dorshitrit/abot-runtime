/** Resource ceilings, not model-specific relevance guarantees. */
export const BASKET_LIMITS = Object.freeze({
  maxSources: 200,
  maxSourceBytes: 10 * 1024 * 1024,
  maxTextCharacters: 750_000,
  maxStoreBytes: 64 * 1024 * 1024,
  maxReadCharacters: 24_000,
  maxQueryCharacters: 4_096,
  maxChunks: 512,
  chunkCharacters: 1_800,
  chunkOverlap: 200,
  embeddingBatchSize: 8,
  embeddingTimeoutMs: 30_000,
  indexTimeoutMs: 120_000,
  searchTimeoutMs: 8_000,
  healthConcurrency: 4,
  healthIntervalMs: 30_000,
  healthTimeoutMs: 8_000,
  maxDimensions: 8_192,
  maxSearchSources: 8,
  previewCharacters: 400,
  maxPdfPages: 1_000,
  pdfTimeoutMs: 30_000,
});

export const BASKET_TEXT_EXTENSIONS = Object.freeze([
  ".txt", ".md", ".csv", ".json", ".log", ".yaml", ".yml",
]);
export const BASKET_SUPPORTED_EXTENSIONS = Object.freeze([
  ...BASKET_TEXT_EXTENSIONS, ".pdf", ".docx",
]);
