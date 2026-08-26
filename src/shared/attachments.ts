export type RuntimeAttachmentKind = "image" | "file";

export const RUNTIME_ATTACHMENT_MIME_TYPES = Object.freeze({
  "image/png": Object.freeze({ kind: "image" as const, extension: ".png" }),
  "image/jpeg": Object.freeze({ kind: "image" as const, extension: ".jpg" }),
  "image/webp": Object.freeze({ kind: "image" as const, extension: ".webp" }),
  "application/pdf": Object.freeze({
    kind: "file" as const,
    extension: ".pdf",
  }),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    Object.freeze({ kind: "file" as const, extension: ".docx" }),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    Object.freeze({ kind: "file" as const, extension: ".xlsx" }),
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    Object.freeze({ kind: "file" as const, extension: ".pptx" }),
  "text/plain": Object.freeze({ kind: "file" as const, extension: ".txt" }),
  "text/csv": Object.freeze({ kind: "file" as const, extension: ".csv" }),
  "text/markdown": Object.freeze({ kind: "file" as const, extension: ".md" }),
  "application/json": Object.freeze({
    kind: "file" as const,
    extension: ".json",
  }),
  "application/rtf": Object.freeze({ kind: "file" as const, extension: ".rtf" }),
} satisfies Readonly<
  Record<string, Readonly<{ kind: RuntimeAttachmentKind; extension: string }>>
>);

export function normalizeRuntimeAttachmentMimeType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

export function resolveRuntimeAttachmentMimeType(
  value: string,
): Readonly<{ kind: RuntimeAttachmentKind; extension: string }> | undefined {
  return RUNTIME_ATTACHMENT_MIME_TYPES[
    normalizeRuntimeAttachmentMimeType(value) as keyof typeof RUNTIME_ATTACHMENT_MIME_TYPES
  ];
}

export type RuntimeAttachmentReference = {
  id: string;
  kind: RuntimeAttachmentKind;
  mimeType: string;
  storageRef: string;
  name?: string;
  size?: number;
};
