import { renderMarkdown } from "../lib/message-markdown.js";
import { createConversationFileFocus } from "./conversation-file-focus.js";

function isMarkdownFile(file) {
  if (file?.kind !== "text") return false;
  if (file.mimeType === "text/markdown") return true;
  return /\.(md|markdown)$/iu.test(file.name);
}

function sizeLabel(bytes) {
  if (bytes < 1024) return String(bytes) + " bytes";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function safeSameOriginUrl(value, baseHref) {
  if (!value) return "";
  try {
    const url = new URL(value, baseHref);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.origin !== new URL(baseHref).origin) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function createConversationFilePreview({
  host,
  documentRoot = document,
  viewport = window,
  onClose,
  onOpenNative,
}) {
  function element(tag, className, value = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = value;
    return node;
  }
  function button(className, label) {
    const node = element("button", className, label);
    node.type = "button";
    return node;
  }

  const panel = element("aside", "conversation-file-preview");
  panel.hidden = true;
  panel.setAttribute("aria-label", "Current file preview");
  const backdrop = button("conversation-file-backdrop", "");
  backdrop.hidden = true;
  backdrop.tabIndex = -1;
  backdrop.setAttribute("aria-label", "Close file preview");
  backdrop.addEventListener("click", onClose);
  const header = element("header", "conversation-file-header");
  const heading = element("div", "conversation-file-heading");
  const title = element("h2", "conversation-file-title", "Current file");
  title.dir = "auto";
  const subtitle = element(
    "p",
    "conversation-file-subtitle",
    "Current file contents",
  );
  heading.append(title, subtitle);
  const closeButton = button("conversation-file-close", "×");
  closeButton.setAttribute("aria-label", "Close file preview");
  closeButton.addEventListener("click", onClose);
  header.append(heading, closeButton);

  const toolbar = element("div", "conversation-file-toolbar");
  toolbar.hidden = true;
  const modes = element("div", "conversation-file-modes");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "File view");
  const previewButton = button("conversation-file-mode", "Preview");
  const sourceButton = button("conversation-file-mode", "Source");
  modes.append(previewButton, sourceButton);
  const openNative = button("conversation-file-open-native", "Open on Mac ↗");
  openNative.title = "Open the original file in its default Mac app";
  openNative.hidden = true;
  openNative.addEventListener("click", () => {
    if (openNative.hidden || openNative.disabled) return;
    void onOpenNative?.();
  });
  const nativeStatus = element("p", "conversation-file-native-status");
  nativeStatus.hidden = true;
  nativeStatus.setAttribute("role", "status");
  nativeStatus.setAttribute("aria-live", "polite");
  toolbar.append(modes, openNative);
  const body = element("div", "conversation-file-body");
  body.tabIndex = 0;
  const notice = element("p", "conversation-file-notice");
  notice.hidden = true;
  const footer = element(
    "footer",
    "conversation-file-footer",
    "Read only · Current file contents",
  );
  panel.append(header, toolbar, nativeStatus, notice, body, footer);
  host.append(backdrop, panel);
  const focus = createConversationFileFocus({
    panel,
    backdrop,
    host,
    closeButton,
    documentRoot,
    viewport,
    onClose,
  });
  let current = null;
  let mode = "preview";

  function renderFileContent() {
    body.replaceChildren();
    previewButton.setAttribute("aria-pressed", String(mode === "preview"));
    sourceButton.setAttribute("aria-pressed", String(mode === "source"));
    if (!current) return;
    const { file } = current;
    if (file.kind === "unsupported") {
      body.appendChild(
        element(
          "p",
          "conversation-file-state",
          "Preview is not available for this file type or size.",
        ),
      );
      return;
    }
    if (file.kind === "image") {
      const imageUrl = safeSameOriginUrl(
        current.imageUrl,
        viewport.location.href,
      );
      if (!imageUrl) return;
      const image = element("img", "conversation-file-image");
      image.alt = file.name;
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => {
        if (!body.contains(image)) return;
        body.replaceChildren(
          element(
            "p",
            "conversation-file-state",
            "The image is no longer available. Try opening the file again.",
          ),
        );
      });
      image.src = imageUrl;
      body.appendChild(image);
      return;
    }
    if (isMarkdownFile(file) && mode === "preview") {
      const markdown = element(
        "div",
        "markdown-body conversation-file-markdown",
      );
      markdown.dir = "auto";
      markdown.innerHTML = renderMarkdown(file.content);
      body.appendChild(markdown);
      return;
    }
    const source = element("pre", "conversation-file-source", file.content);
    source.dir = "auto";
    body.appendChild(source);
  }

  previewButton.addEventListener("click", () => {
    mode = "preview";
    renderFileContent();
  });
  sourceButton.addEventListener("click", () => {
    mode = "source";
    renderFileContent();
  });

  function render(state) {
    panel.hidden = !state.open;
    host.classList.toggle("has-file-preview", state.open);
    if (!state.open) {
      current = null;
      body.replaceChildren();
      openNative.hidden = true;
      nativeStatus.hidden = true;
      focus.hide(state.restoreFocus !== false);
      return;
    }
    if (state.status === "native") {
      openNative.disabled = state.nativeStatus === "opening";
      openNative.textContent = openNative.disabled
        ? "Opening…"
        : "Open on Mac ↗";
      nativeStatus.hidden = state.nativeStatus === "opening";
      nativeStatus.textContent =
        state.nativeStatus === "error"
          ? state.nativeError
          : "Sent to your Mac app";
      return;
    }
    focus.show(state.opener);
    body.setAttribute("aria-busy", String(state.status === "loading"));
    if (state.status === "loading") {
      current = null;
      mode = "preview";
      openNative.disabled = false;
      openNative.textContent = "Open on Mac ↗";
      title.textContent = state.name || "Current file";
      subtitle.textContent = "Current file contents";
      toolbar.hidden = true;
      notice.hidden = true;
      openNative.hidden = true;
      nativeStatus.hidden = true;
      body.replaceChildren(
        element("p", "conversation-file-state", "Loading file…"),
      );
      body.scrollTop = 0;
      return;
    }
    if (state.status === "error") {
      toolbar.hidden = true;
      openNative.hidden = true;
      nativeStatus.hidden = true;
      const error = element("p", "conversation-file-state", state.error);
      error.setAttribute("role", "alert");
      body.replaceChildren(error);
      return;
    }
    current = state;
    const { file } = state;
    title.textContent = file.name;
    subtitle.textContent = sizeLabel(file.size) + " · Current file";
    modes.hidden = !isMarkdownFile(file);
    openNative.hidden =
      file.nativeOpenAvailable !== true || typeof onOpenNative !== "function";
    openNative.disabled = false;
    openNative.textContent = "Open on Mac ↗";
    nativeStatus.hidden = true;
    toolbar.hidden = modes.hidden && openNative.hidden;
    notice.hidden = !file.truncated;
    notice.textContent = openNative.hidden
      ? "Showing the beginning of this file. Open the original on your computer to read it in full."
      : "Showing the beginning of this file. Open on Mac to read it in full.";
    renderFileContent();
  }

  return { render, panel };
}
