import { isImageAttachmentMimeType } from "../lib/attachment-policy.js";

function attachmentName(attachment) {
  const name =
    typeof attachment?.name === "string" ? attachment.name.trim() : "";
  if (name) return name;
  const id = typeof attachment?.id === "string" ? attachment.id.trim() : "";
  return id || "file";
}

function safeSameOriginImageUrl(value, baseHref) {
  if (typeof value !== "string" || !value.trim() || !baseHref) return "";
  try {
    const base = new URL(baseHref);
    const resolved = new URL(value, base);
    if (
      (resolved.protocol !== "http:" && resolved.protocol !== "https:") ||
      resolved.origin !== base.origin
    ) {
      return "";
    }
    return resolved.href;
  } catch {
    return "";
  }
}

export function buildMessageAttachmentsModel({
  attachments,
  resolveAttachmentUrl,
  baseHref = globalThis.location?.href,
} = {}) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter(
      (attachment) =>
        attachment &&
        typeof attachment === "object" &&
        !Array.isArray(attachment),
    )
    .map((attachment) => {
      const name = attachmentName(attachment);
      const isImage =
        attachment.kind === "image" &&
        isImageAttachmentMimeType(attachment.mimeType);
      let imageUrl = "";
      if (isImage && typeof resolveAttachmentUrl === "function") {
        try {
          imageUrl = safeSameOriginImageUrl(
            resolveAttachmentUrl(attachment),
            baseHref,
          );
        } catch {
          imageUrl = "";
        }
      }
      return {
        name,
        kind: imageUrl ? "image" : "file",
        imageUrl,
      };
    });
}

export function createMessageAttachments({
  documentRoot = document,
  resolveAttachmentUrl,
} = {}) {
  function createNode(attachments) {
    const items = buildMessageAttachmentsModel({
      attachments,
      resolveAttachmentUrl,
      baseHref: documentRoot.baseURI,
    });
    if (items.length === 0) return null;

    const container = documentRoot.createElement("div");
    container.className = "message-attachments";
    container.setAttribute("aria-label", "Attachments");

    for (const item of items) {
      const attachment = documentRoot.createElement(
        item.kind === "image" ? "figure" : "span",
      );
      attachment.className = `message-attachment ${item.kind}`;

      if (item.kind === "image") {
        const image = documentRoot.createElement("img");
        image.className = "message-attachment-image";
        image.src = item.imageUrl;
        image.alt = item.name;
        image.loading = "lazy";
        image.decoding = "async";
        image.addEventListener("error", () => {
          image.hidden = true;
          attachment.classList.add("load-failed");
        });
        attachment.appendChild(image);
      }

      const label = documentRoot.createElement(
        item.kind === "image" ? "figcaption" : "span",
      );
      label.className = "message-attachment-name";
      label.textContent = item.name;
      attachment.appendChild(label);
      container.appendChild(attachment);
    }

    return container;
  }

  return { createNode };
}
