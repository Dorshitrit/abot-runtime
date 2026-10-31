import { createConversationFileFocus } from "./conversation-file-focus.js";
import { createProjectDiff } from "./project-diff.js";

export function projectChangesCountLabel(changes) {
  if (changes.truncated) return `Showing ${changes.files.length} of ${changes.totalFiles} files`;
  const count = `${changes.totalFiles} file${changes.totalFiles === 1 ? "" : "s"}`;
  if (changes.additions === null || changes.deletions === null) return count;
  return `${count} · +${changes.additions} −${changes.deletions}`;
}

export function createProjectChangesPreview({ host, documentRoot = document, viewport = window, onClose, onRefresh, onSelect }) {
  function element(tag, className, text = "") {
    const node = documentRoot.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function button(className, text, action) {
    const node = element("button", className, text);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  const panel = element("aside", "conversation-file-preview conversation-project-changes-preview");
  panel.hidden = true;
  panel.setAttribute("aria-label", "Project changes");
  const backdrop = button("conversation-file-backdrop", "", onClose);
  backdrop.hidden = true;
  backdrop.tabIndex = -1;
  backdrop.setAttribute("aria-label", "Close project changes");
  const header = element("header", "conversation-file-header");
  const heading = element("div", "conversation-file-heading");
  heading.appendChild(element("h2", "conversation-file-title", "Project changes"));
  const subtitle = element("p", "conversation-file-subtitle", "Current working tree");
  heading.appendChild(subtitle);
  const close = button("conversation-file-close", "×", onClose);
  close.setAttribute("aria-label", "Close project changes");
  header.append(heading, close);
  const toolbar = element("div", "conversation-file-toolbar");
  const refresh = button("conversation-file-mode", "Refresh", () => void onRefresh());
  toolbar.appendChild(refresh);
  const body = element("div", "conversation-file-body project-changes-body");
  const notice = element("p", "conversation-file-state project-changes-notice");
  notice.setAttribute("role", "status");
  const files = element("ul", "project-changes-files");
  files.setAttribute("aria-label", "Changed files");
  const detail = element("section", "project-changes-detail");
  body.append(notice, files, detail);
  const footer = element("footer", "conversation-file-footer", "Read only · Submodule contents excluded");
  panel.append(header, toolbar, body, footer);
  host.append(backdrop, panel);
  const focus = createConversationFileFocus({
    panel, backdrop, host, closeButton: close, documentRoot, viewport, onClose,
    resolveReturnTarget: () => host.querySelector("#composerInput"),
  });
  let open = false;

  function renderFileList(state) {
    const activeId = documentRoot.activeElement?.dataset?.projectChangeFile;
    files.replaceChildren();
    for (const file of state.changes?.files ?? []) {
      const row = element("li", "project-changes-file");
      const select = button("project-changes-file-select", "", () => void onSelect(file.id));
      select.dataset.projectChangeFile = file.id;
      select.setAttribute("aria-pressed", String(state.selectedId === file.id));
      const name = element("span", "project-changes-file-name", file.path);
      name.dir = "ltr";
      const status = file.status.replaceAll("_", " ");
      const stats = file.binary ? "Binary" : `+${file.additions ?? "?"} −${file.deletions ?? "?"}`;
      select.append(name, element("span", "project-changes-file-status", status), element("span", "project-changes-file-counts", stats));
      row.appendChild(select);
      files.appendChild(row);
      if (activeId === file.id) select.focus({ preventScroll: true });
    }
  }
  function renderDiff(state) {
    detail.replaceChildren();
    detail.setAttribute("aria-busy", String(state.fileLoading));
    if (state.fileLoading) {
      detail.appendChild(element("p", "conversation-file-state", "Loading changes…"));
      return;
    }
    if (state.fileError) {
      detail.appendChild(element("p", "conversation-file-state", state.fileError));
      return;
    }
    if (!state.file) {
      if (state.changes?.files.length) detail.appendChild(element("p", "conversation-file-state", "Select a file to view its changes."));
      return;
    }
    const title = element("h3", "project-changes-detail-title", state.file.path);
    title.dir = "ltr";
    detail.appendChild(title);
    detail.appendChild(createProjectDiff({ file: state.file, documentRoot }));
  }
  function render(state) {
    const restoreComposerFocus = open && state.restoreFocus && panel.contains(documentRoot.activeElement);
    panel.hidden = !state.open;
    if (!state.open) {
      if (open) host.classList.remove("has-file-preview");
      open = false;
      focus.hide(state.restoreFocus);
      if (restoreComposerFocus) host.querySelector("#composerInput")?.focus({ preventScroll: true });
      files.replaceChildren();
      detail.replaceChildren();
      notice.textContent = "";
      return;
    }
    open = true;
    host.classList.add("has-file-preview");
    focus.show(state.opener, { focusOnOpen: false });
    refresh.disabled = state.loading;
    body.setAttribute("aria-busy", String(state.loading));
    subtitle.textContent = "Current working tree";
    footer.textContent = state.changes?.truncated
      ? "Read only · Limited file list · Submodule contents excluded" : "Read only · Submodule contents excluded";
    if (state.changes?.base === "empty") subtitle.textContent += " · Initial repository";
    if (state.changes?.base === "head") subtitle.textContent += " · Compared with HEAD";
    notice.textContent = state.loading ? "Checking current project changes…" : state.error;
    if (state.changes?.status === "available") {
      notice.textContent = state.changes.totalFiles ? projectChangesCountLabel(state.changes) : "No current changes.";
    }
    if (state.changes && state.changes.status !== "available") notice.textContent = state.changes.message || "Project changes are unavailable.";
    renderFileList(state);
    renderDiff(state);
  }
  return { render, panel };
}
