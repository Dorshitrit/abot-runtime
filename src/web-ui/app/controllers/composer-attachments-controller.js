import {
  isImageAttachmentMimeType,
  resolveComposerAttachmentMimeType,
} from "../lib/attachment-policy.js";
import { escapeHtml, textOf } from "../lib/text-format.js";

export function createComposerAttachmentsController({
  getDraft,
  canDeleteAttachment = () => true,
  dom,
  shell,
  client,
  selectedEnvironmentId,
  selectedModelSupportsImageInput,
  ensureSession,
  onSendStateChange,
  onControlEvent,
  isComposerAvailable = () => true,
  isComposerVisible = () => true,
}) {
  function attachmentSessionId(attachment) {
    const explicitSessionId = textOf(attachment.sessionId).trim();
    if (explicitSessionId) return explicitSessionId;
    return textOf(attachment.storageRef).trim().split(/[\\/]/u)[0] || "";
  }

  function attachmentEnvironmentId(attachment) {
    return textOf(attachment.environment).trim() || selectedEnvironmentId();
  }

  function previewUrl(attachment) {
    const storageRef = textOf(attachment.storageRef).trim();
    const id = textOf(attachment.id).trim();
    const mimeType = textOf(attachment.mimeType).trim().toLowerCase();
    const sessionId = attachmentSessionId(attachment) || getDraft().scope.sessionId;
    if (!storageRef || !id || !mimeType || !sessionId) return "";
    return client.attachmentPreviewUrl({
      environmentId: attachmentEnvironmentId(attachment),
      sessionId,
      storageRef,
      id,
      mimeType,
    });
  }

  async function deletePending(attachment) {
    const storageRef = textOf(attachment.storageRef).trim();
    const id = textOf(attachment.id).trim();
    const mimeType = textOf(attachment.mimeType).trim();
    const sessionId = attachmentSessionId(attachment);
    if (!storageRef || !id || !mimeType || !sessionId) return;
    if (!canDeleteAttachment(attachment)) return;
    try {
      await client.deleteAttachment({
        environmentId: attachmentEnvironmentId(attachment),
        sessionId,
        storageRef,
        id,
        mimeType,
      });
    } catch (error) {
      onControlEvent({
        type: "control",
        name: "Attachment cleanup failed",
        tone: "failed",
        summary: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function cleanup(attachments) {
    for (const attachment of attachments) void deletePending(attachment);
  }

  function activeUploadCount() { return getDraft().uploading; }

  function render() {
    if (!isComposerVisible()) return;
    const available = isComposerAvailable();
    dom.attachmentButton.disabled = !available;
    dom.attachmentButton.title = !available
      ? "Configure a provider and model before attaching files"
      : selectedModelSupportsImageInput()
        ? "Attach a file or image"
        : "Attach a document (this model does not accept images)";
    dom.attachmentPreview.innerHTML = "";
    for (const attachment of getDraft().attachments) {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      chip.innerHTML = `
        <span>${escapeHtml(attachment.name || attachment.id || "file")}</span>
        <button type="button" aria-label="Remove attachment">×</button>
      `;
      chip.querySelector("button")?.addEventListener("click", () => {
        getDraft().attachments = getDraft().attachments.filter(
          (item) => item.id !== attachment.id,
        );
        void deletePending(attachment);
        render();
      });
      dom.attachmentPreview.appendChild(chip);
    }
    onSendStateChange();
  }

  function removeUnsupportedImages() {
    if (selectedModelSupportsImageInput()) return;
    const unsupported = getDraft().attachments.filter(
      (attachment) =>
        attachment.kind === "image" ||
        isImageAttachmentMimeType(attachment.mimeType),
    );
    if (unsupported.length === 0) return;
    const unsupportedIds = new Set(
      unsupported.map((attachment) => attachment.id),
    );
    getDraft().attachments = getDraft().attachments.filter(
      (attachment) => !unsupportedIds.has(attachment.id),
    );
    cleanup(unsupported);
    shell.showToast(
      "Images were removed because the selected model is text-only",
    );
  }

  function clear(options = {}) {
    const draft = getDraft();
    const attachments = draft.clearAttachments();
    render();
    if (options.cleanup !== false) cleanup(attachments);
  }

  function canRetainUploadedAttachment(draft, imageAttachment) {
    if (!imageAttachment) return true;
    if (draft !== getDraft()) return true;
    return selectedModelSupportsImageInput();
  }

  async function upload(file) {
    if (!isComposerAvailable()) {
      throw new Error("Configure a provider and model before attaching files.");
    }
    const mimeType = resolveComposerAttachmentMimeType(file);
    if (!mimeType) throw new Error("This file type is not supported");
    const imageAttachment = isImageAttachmentMimeType(mimeType);
    if (imageAttachment && !selectedModelSupportsImageInput()) {
      throw new Error("Selected model does not support image input");
    }
    if (getDraft().attachments.length + getDraft().uploading >= 4) {
      throw new Error("You can attach up to 4 files to one request");
    }
    ensureSession();
    const draft = getDraft();
    const uploadEnvironmentId = draft.scope.environmentId;
    const uploadSessionId = draft.scope.sessionId;
    const uploadGeneration = draft.startUpload();
    try {
      const uploadedAttachment = await client.uploadAttachment({
        environmentId: uploadEnvironmentId,
        sessionId: uploadSessionId,
        name: file.name || (imageAttachment ? "image" : "file"),
        mimeType,
        file,
      });
      const attachment = {
        ...uploadedAttachment,
        sessionId: uploadSessionId,
        environment: uploadEnvironmentId,
      };
      if (!canRetainUploadedAttachment(draft, imageAttachment)) {
        void deletePending(attachment);
        return;
      }
      if (!draft.acceptUpload(uploadGeneration, attachment)) {
        void deletePending(attachment);
        return;
      }
      render();
    } finally {
      draft.finishUpload(uploadGeneration);
      onSendStateChange();
    }
  }

  return {
    activeUploadCount,
    clear,
    cleanup,
    deletePending,
    previewUrl,
    removeUnsupportedImages,
    render,
    upload,
  };
}
