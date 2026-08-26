import {
  isImageAttachmentMimeType,
  resolveComposerAttachmentMimeType,
} from "../lib/attachment-policy.js";
import { escapeHtml, textOf } from "../lib/text-format.js";

export function createComposerAttachmentsController({
  state,
  dom,
  shell,
  client,
  selectedEnvironmentId,
  selectedModelSupportsImageInput,
  ensureSession,
  onSendStateChange,
  onControlEvent,
  isComposerAvailable = () => true,
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
    const sessionId = attachmentSessionId(attachment) || state.currentSessionId;
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

  function activeUploadCount() {
    return (
      state.pendingAttachmentUploadCounts.get(
        state.composerAttachmentGeneration,
      ) ?? 0
    );
  }

  function pruneUploadCounts() {
    for (const generation of state.pendingAttachmentUploadCounts.keys()) {
      if (generation !== state.composerAttachmentGeneration) {
        state.pendingAttachmentUploadCounts.delete(generation);
      }
    }
  }

  function invalidateCompletions() {
    state.composerAttachmentGeneration += 1;
    pruneUploadCounts();
    onSendStateChange();
  }

  function setUploadInProgress(uploading, generation) {
    const uploadGeneration =
      Number.isFinite(generation) && generation >= 0
        ? generation
        : state.composerAttachmentGeneration;
    const nextCount = Math.max(
      0,
      (state.pendingAttachmentUploadCounts.get(uploadGeneration) ?? 0) +
        (uploading ? 1 : -1),
    );
    if (nextCount === 0)
      state.pendingAttachmentUploadCounts.delete(uploadGeneration);
    else state.pendingAttachmentUploadCounts.set(uploadGeneration, nextCount);
    onSendStateChange();
  }

  function render() {
    const available = isComposerAvailable();
    dom.attachmentButton.disabled = !available;
    dom.attachmentButton.title = !available
      ? "Configure a provider and model before attaching files"
      : selectedModelSupportsImageInput()
        ? "Attach a file or image"
        : "Attach a document (this model does not accept images)";
    dom.attachmentPreview.innerHTML = "";
    for (const attachment of state.pendingAttachments) {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      chip.innerHTML = `
        <span>${escapeHtml(attachment.name || attachment.id || "file")}</span>
        <button type="button" aria-label="Remove attachment">×</button>
      `;
      chip.querySelector("button")?.addEventListener("click", () => {
        state.pendingAttachments = state.pendingAttachments.filter(
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
    const unsupported = state.pendingAttachments.filter(
      (attachment) =>
        attachment.kind === "image" ||
        isImageAttachmentMimeType(attachment.mimeType),
    );
    if (unsupported.length === 0) return;
    const unsupportedIds = new Set(
      unsupported.map((attachment) => attachment.id),
    );
    state.pendingAttachments = state.pendingAttachments.filter(
      (attachment) => !unsupportedIds.has(attachment.id),
    );
    cleanup(unsupported);
    shell.showToast(
      "Images were removed because the selected model is text-only",
    );
  }

  function clear(options = {}) {
    invalidateCompletions();
    if (state.pendingAttachments.length === 0) return;
    const attachments = [...state.pendingAttachments];
    state.pendingAttachments = [];
    render();
    if (options.cleanup !== false) cleanup(attachments);
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
    if (state.pendingAttachments.length >= 4) {
      throw new Error("You can attach up to 4 files to one request");
    }
    ensureSession();
    const uploadEnvironmentId = selectedEnvironmentId();
    const uploadSessionId = state.currentSessionId;
    invalidateCompletions();
    const uploadGeneration = state.composerAttachmentGeneration;
    setUploadInProgress(true, uploadGeneration);
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
      if (
        state.currentSessionId !== uploadSessionId ||
        selectedEnvironmentId() !== uploadEnvironmentId ||
        state.composerAttachmentGeneration !== uploadGeneration ||
        (imageAttachment && !selectedModelSupportsImageInput())
      ) {
        void deletePending(attachment);
        return;
      }
      state.pendingAttachments = [...state.pendingAttachments, attachment];
      render();
    } finally {
      setUploadInProgress(false, uploadGeneration);
    }
  }

  return {
    activeUploadCount,
    clear,
    cleanup,
    deletePending,
    invalidateCompletions,
    previewUrl,
    removeUnsupportedImages,
    render,
    setUploadInProgress,
    upload,
  };
}
