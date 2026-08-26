export type MessageAttachmentInput = {
  id?: unknown;
  kind?: unknown;
  mimeType?: unknown;
  name?: unknown;
  storageRef?: unknown;
  [key: string]: unknown;
};

export type MessageAttachmentItem = {
  name: string;
  kind: "image" | "file";
  imageUrl: string;
};

export declare function buildMessageAttachmentsModel(input?: {
  attachments?: unknown;
  resolveAttachmentUrl?: (attachment: MessageAttachmentInput) => unknown;
  baseHref?: string;
}): MessageAttachmentItem[];

export declare function createMessageAttachments(options?: {
  documentRoot?: Document;
  resolveAttachmentUrl?: (attachment: MessageAttachmentInput) => unknown;
}): {
  createNode(attachments?: unknown): HTMLElement | null;
};
