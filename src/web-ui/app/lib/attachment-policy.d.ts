export type ComposerAttachmentFile = {
  name?: unknown;
  type?: unknown;
};

export declare function resolveComposerAttachmentMimeType(
  file: ComposerAttachmentFile | null | undefined,
): string;

export declare function isImageAttachmentMimeType(mimeType: unknown): boolean;

export declare function modelAcceptsComposerAttachment(
  file: ComposerAttachmentFile | null | undefined,
  supportsImageInput: boolean,
): boolean;
