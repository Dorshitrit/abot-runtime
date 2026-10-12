import type { ComposerAttachment, ComposerDraft } from "./composer-drafts.js";
export type { ComposerAttachment } from "./composer-drafts.js";

export type ComposerUploadFile = Blob & { name?: string };

export interface ComposerAttachmentsDom {
  attachmentButton: { disabled: boolean; title: string };
  attachmentPreview: { innerHTML: string; appendChild(child: HTMLElement): unknown };
}

export interface ComposerAttachmentsShell {
  showToast(message: string): void;
}

export interface ComposerAttachmentLocation {
  environmentId: string;
  sessionId: string;
  storageRef: string;
  id: string;
  mimeType: string;
}

export interface ComposerAttachmentsClient {
  attachmentPreviewUrl(location: ComposerAttachmentLocation): string;
  deleteAttachment(location: ComposerAttachmentLocation): Promise<void>;
  uploadAttachment(options: {
    environmentId: string;
    sessionId: string;
    name: string;
    mimeType: string;
    file: Blob;
  }): Promise<ComposerAttachment>;
}

export interface ComposerAttachmentControlEvent {
  type: "control";
  name: string;
  tone: "failed";
  summary: string;
}

export interface ComposerAttachmentsControllerOptions {
  getDraft(): ComposerDraft;
  canDeleteAttachment?(attachment: ComposerAttachment): boolean;
  dom: ComposerAttachmentsDom;
  shell: ComposerAttachmentsShell;
  client: ComposerAttachmentsClient;
  selectedEnvironmentId(): string;
  selectedModelSupportsImageInput(): boolean;
  ensureSession(): void;
  onSendStateChange(): void;
  onControlEvent(event: ComposerAttachmentControlEvent): void;
  isComposerAvailable?(): boolean;
  isComposerVisible?(): boolean;
}

export interface ComposerAttachmentsController {
  activeUploadCount(): number;
  clear(options?: { cleanup?: boolean }): void;
  cleanup(attachments: readonly ComposerAttachment[]): void;
  deletePending(attachment: ComposerAttachment): Promise<void>;
  previewUrl(attachment: ComposerAttachment): string;
  removeUnsupportedImages(): void;
  render(): void;
  upload(file: ComposerUploadFile): Promise<void>;
}

export declare function createComposerAttachmentsController(options: ComposerAttachmentsControllerOptions): ComposerAttachmentsController;
