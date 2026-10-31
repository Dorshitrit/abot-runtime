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

export type { ArchiveExtractionMetadata, ExtractedDocument, FormatExtractionMetadata } from "../../../src/plugin-sdk/document-text.js";
