import { basename, extname, posix, win32 } from "node:path";

import {
  resolvePluginPath,
  type RuntimePluginLoadContext,
  type ToolExecutionContext,
} from "../../../src/plugin-sdk/index.js";

import { EXTENSION_MIME_TYPES, MIME_TYPE_ALIASES } from "./constants.js";
import { failDocument } from "./errors.js";
import type {
  DocumentReference,
  RequestAttachment,
  SupportedMimeType,
} from "./types.js";

const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set(
  Object.values(EXTENSION_MIME_TYPES),
);

function supportedMimeType(value: string): SupportedMimeType | undefined {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const alias =
    MIME_TYPE_ALIASES[normalized as keyof typeof MIME_TYPE_ALIASES] ??
    normalized;
  return SUPPORTED_MIME_TYPES.has(alias)
    ? (alias as SupportedMimeType)
    : undefined;
}

function mimeTypeFromName(value: string): SupportedMimeType | undefined {
  return EXTENSION_MIME_TYPES[
    extname(value).toLowerCase() as keyof typeof EXTENSION_MIME_TYPES
  ];
}

function attachmentDisplayName(attachment: RequestAttachment): string {
  const candidate = attachment.name?.trim() || attachment.id;
  return posix.basename(win32.basename(candidate));
}

function attachmentMimeType(attachment: RequestAttachment): SupportedMimeType {
  const displayName = attachmentDisplayName(attachment);
  const mimeType =
    supportedMimeType(attachment.mimeType) ?? mimeTypeFromName(displayName);
  if (!mimeType) {
    failDocument(
      "document_type_unsupported",
      "The requested attachment has an unsupported document type.",
    );
  }
  return mimeType;
}

function resolveAttachment(
  source: string,
  attachments: readonly RequestAttachment[],
): RequestAttachment | undefined {
  const exactId = attachments.find((attachment) => attachment.id === source);
  if (exactId) return exactId;
  const byName = attachments.filter((attachment) => attachment.name === source);
  if (byName.length > 1) {
    failDocument(
      "document_attachment_ambiguous",
      "Multiple request attachments share that name; use the attachment id.",
    );
  }
  return byName[0];
}

function resolveRuntimePathDocument(
  rawPath: string,
  loadContext: RuntimePluginLoadContext,
  executionContext?: ToolExecutionContext,
): DocumentReference {
  const runtimePathResolver =
    executionContext?.runtimePathResolver ?? loadContext.runtimePathResolver;
  const target = resolvePluginPath({ runtimePathResolver }, rawPath, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"],
  });
  const mimeType = mimeTypeFromName(target.logicalPath);
  if (!mimeType) {
    failDocument(
      "document_type_unsupported",
      "The requested path has an unsupported document type.",
    );
  }
  return Object.freeze({
    kind: "runtime_path",
    absolutePath: target.absolutePath,
    rootPath: target.rootPath,
    displayName: basename(target.logicalPath),
    mimeType,
    path: Object.freeze({
      location: target.location,
      logicalPath: target.logicalPath,
    }),
  });
}

export function resolveDocumentReference(
  params: {
    loadContext: RuntimePluginLoadContext;
    executionContext?: ToolExecutionContext;
  } & (
    | Readonly<{ sourceMode: "source"; source: string }>
    | Readonly<{ sourceMode: "working_path"; workingPath: string }>
  ),
): DocumentReference {
  if (params.sourceMode === "working_path") {
    return resolveRuntimePathDocument(
      params.workingPath,
      params.loadContext,
      params.executionContext,
    );
  }
  const attachment = resolveAttachment(
    params.source,
    params.executionContext?.sharedState?.requestAttachments ?? [],
  );
  if (!attachment) {
    return resolveRuntimePathDocument(
      params.source,
      params.loadContext,
      params.executionContext,
    );
  }
  return Object.freeze({
    kind: "attachment",
    absolutePath: attachment.absolutePath,
    rootPath: params.loadContext.runtimePaths.attachmentsDir,
    attachmentId: attachment.id,
    displayName: attachmentDisplayName(attachment),
    mimeType: attachmentMimeType(attachment),
  });
}
