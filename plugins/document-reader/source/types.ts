import type {
  ResolvedRuntimeToolPath,
  ToolExecutionContext,
} from "../../../src/plugin-sdk/index.js";

import type { EXTENSION_MIME_TYPES } from "./constants.js";

export type SupportedMimeType =
  (typeof EXTENSION_MIME_TYPES)[keyof typeof EXTENSION_MIME_TYPES];

export type RequestAttachment = NonNullable<
  NonNullable<ToolExecutionContext["sharedState"]>["requestAttachments"]
>[number];

export type AttachmentDocumentReference = Readonly<{
  kind: "attachment";
  absolutePath: string;
  rootPath: string;
  attachmentId: string;
  displayName: string;
  mimeType: SupportedMimeType;
}>;

export type RuntimePathDocumentReference = Readonly<{
  kind: "runtime_path";
  absolutePath: string;
  rootPath: string;
  displayName: string;
  mimeType: SupportedMimeType;
  path: Pick<ResolvedRuntimeToolPath, "location" | "logicalPath">;
}>;

export type DocumentReference =
  | AttachmentDocumentReference
  | RuntimePathDocumentReference;

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
