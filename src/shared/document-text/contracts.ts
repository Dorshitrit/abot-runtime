export type ArchiveExtractionMetadata = Readonly<{
  declaredEntries: number;
  declaredUncompressedBytes: number;
  processedXmlEntries: number;
  expandedXmlBytes: number;
  limits: Readonly<{
    maxEntries: number;
    maxDeclaredUncompressedBytes: number;
    maxXmlEntryBytes: number;
    maxExpandedXmlBytes: number;
  }>;
}>;

export type FormatExtractionMetadata =
  | Readonly<{
      kind: "archive";
      archive: ArchiveExtractionMetadata;
    }>
  | Readonly<{
      kind: "pdf";
      totalPages: number;
      processedPages: number;
      maxPages: number;
    }>
  | Readonly<{ kind: "text" }>;

export type ExtractedDocument = Readonly<{
  text: string;
  textBounds: Readonly<{
    truncated: boolean;
    totalCharacters: number;
    returnedCharacters: number;
    omittedCharacters: number;
    maxCharacters: number;
  }>;
  format: FormatExtractionMetadata;
}>;
