const attachmentMimeByExtension = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
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
});

const supportedAttachmentMimeTypes = new Set(
  Object.values(attachmentMimeByExtension),
);

export function resolveComposerAttachmentMimeType(file) {
  const declared = String(file?.type ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (supportedAttachmentMimeTypes.has(declared)) return declared;
  const name = String(file?.name ?? "")
    .trim()
    .toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  return attachmentMimeByExtension[extension] || "";
}

export function isImageAttachmentMimeType(mimeType) {
  return String(mimeType ?? "")
    .trim()
    .toLowerCase()
    .startsWith("image/");
}

export function modelAcceptsComposerAttachment(file, supportsImageInput) {
  const mimeType = resolveComposerAttachmentMimeType(file);
  return Boolean(
    mimeType &&
    (!isImageAttachmentMimeType(mimeType) || supportsImageInput === true),
  );
}
