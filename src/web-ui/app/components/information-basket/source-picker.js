import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { basketIcon } from "./icons.js";

export function renderBasketPickerEntries(picker) {
  const entries = picker.page?.entries || [];
  if (!entries.length) return `<p class="basket-empty">${picker.loading ? "Reading this folder…" : "No files in this folder."}</p>`;
  return entries.map((entry) => {
    if (entry.kind === "directory") return `<button type="button" class="basket-picker-entry" data-basket-directory="${escapeAttribute(entry.path)}">${basketIcon("folder")}<span dir="auto">${escapeHtml(entry.name)}</span><span class="basket-entry-kind">Folder</span></button>`;
    return `<label class="basket-picker-entry${entry.supported ? "" : " basket-entry-unsupported"}"><input type="checkbox" data-basket-picker-select="${escapeAttribute(entry.path)}" ${entry.supported && !picker.loading ? "" : "disabled"}>${basketIcon("file")}<span dir="auto">${escapeHtml(entry.name)}</span>${entry.supported ? "" : '<span class="basket-entry-kind">Unsupported</span>'}</label>`;
  }).join("");
}

export function createBasketSourcePicker({ root, actions, documentRoot = document,
  idPrefix = "basket-picker", heading = "Choose source files", actionLabel = "Add selected" }) {
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "basket-picker-dialog";
  dialog.setAttribute("aria-labelledby", `${idPrefix}-title`);
  dialog.innerHTML = `<div class="basket-picker-content"><header class="basket-picker-heading"><div><h2 id="${escapeAttribute(idPrefix)}-title">${escapeHtml(heading)}</h2><p data-basket-picker-caption></p></div><button type="button" class="basket-text-button" data-basket-picker-close autofocus>Close</button></header>
    <p class="basket-note">Select files on the computer running ABot. Original files stay in place.</p><nav class="basket-picker-roots" aria-label="Available locations" data-basket-picker-roots></nav>
    <form class="basket-picker-path" data-basket-path-form><label>File or folder path<input type="text" dir="ltr" spellcheck="false" autocomplete="off" data-basket-path aria-label="Source file or folder path"></label><button type="submit" data-basket-path-go>Open folder</button><button type="button" data-basket-path-add>Link file path</button></form>
    <p class="basket-feedback" role="alert" data-basket-picker-error hidden></p><div class="basket-picker-location"><button type="button" data-basket-parent>Up one folder</button><span dir="ltr" data-basket-directory-name></span></div>
    <div class="basket-picker-selection" data-basket-picker-selection><button type="button" class="basket-text-button" data-basket-picker-select-all aria-describedby="${escapeAttribute(idPrefix)}-selection-note">Select all files in this folder</button><button type="button" class="basket-text-button" data-basket-picker-clear>Clear selection</button><span id="${escapeAttribute(idPrefix)}-selection-note" class="basket-note">Supported files only; subfolders are excluded.</span></div>
    <div class="basket-picker-entries" data-basket-picker-entries></div><button type="button" class="basket-text-button" data-basket-picker-more hidden>Load more files</button>
    </div><footer class="basket-picker-footer"><span role="status" aria-live="polite" aria-atomic="true" data-basket-picker-count></span><button type="button" class="primary-button" data-basket-picker-add>Add selected</button></footer>`;
  root.append(dialog);
  const find = (selector) => dialog.querySelector(selector);
  let current;
  let entriesMarkup = "";
  let rootsMarkup = "";
  let returnFocus;
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); actions.close(); });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); actions.close();
  });
  dialog.addEventListener("click", (event) => {
    const target = event.target.closest?.("button");
    if (!target) return;
    if (target.hasAttribute("data-basket-picker-close")) actions.close();
    if (target.hasAttribute("data-basket-directory")) void actions.browse(target.dataset.basketDirectory);
    if (target.hasAttribute("data-basket-parent") && current?.page?.parent) void actions.browse(current.page.parent);
    if (target.hasAttribute("data-basket-path-add")) void actions.addDraft();
    if (target.hasAttribute("data-basket-picker-add")) void actions.submit();
    if (target.hasAttribute("data-basket-picker-more")) void actions.more();
    if (target.hasAttribute("data-basket-picker-select-all")) void actions.selectAll();
    if (target.hasAttribute("data-basket-picker-clear")) actions.clearSelection();
  });
  find("[data-basket-path-form]").addEventListener("submit", (event) => { event.preventDefault(); void actions.browseDraft(); });
  find("[data-basket-path]").addEventListener("input", (event) => actions.setPath(event.target.value));
  dialog.addEventListener("change", (event) => {
    if (event.target.hasAttribute?.("data-basket-picker-select")) actions.select(event.target.dataset.basketPickerSelect);
  });
  function render(picker, mutation) {
    current = picker;
    if (!picker.open) {
      if (dialog.open) dialog.close();
      if (returnFocus?.isConnected && !returnFocus.closest("[hidden], [inert]")) returnFocus.focus();
      returnFocus = null;
      return;
    }
    if (!dialog.open) { returnFocus = documentRoot.activeElement; dialog.showModal(); }
    find("[data-basket-picker-caption]").textContent = picker.linkName ? `Link original source: ${picker.linkName}` : "Linked sources are available across your chats.";
    const input = find("[data-basket-path]");
    if (input.value !== picker.pathDraft) input.value = picker.pathDraft;
    const nextRoots = (picker.page?.roots || []).map((entry) => `<button type="button" class="basket-text-button" data-basket-directory="${escapeAttribute(entry.path)}">${escapeHtml(entry.label)}</button>`).join("");
    if (rootsMarkup !== nextRoots) { find("[data-basket-picker-roots]").innerHTML = nextRoots; rootsMarkup = nextRoots; }
    const busy = picker.loading || Boolean(mutation);
    const nextEntries = renderBasketPickerEntries({ ...picker, loading: busy });
    if (nextEntries !== entriesMarkup) { find("[data-basket-picker-entries]").innerHTML = nextEntries; entriesMarkup = nextEntries; }
    find("[data-basket-picker-entries]").setAttribute("aria-busy", String(picker.loading));
    for (const checkbox of dialog.querySelectorAll("[data-basket-picker-select]")) checkbox.checked = picker.selectedPaths.includes(checkbox.dataset.basketPickerSelect);
    find("[data-basket-directory-name]").textContent = picker.page?.directory || "";
    find("[data-basket-picker-error]").textContent = picker.error;
    find("[data-basket-picker-error]").hidden = !picker.error;
    find("[data-basket-parent]").disabled = picker.loading || !picker.page?.parent;
    find("[data-basket-picker-more]").hidden = !picker.page?.nextCursor;
    find("[data-basket-picker-more]").disabled = picker.loading;
    find("[data-basket-picker-selection]").hidden = Boolean(picker.linkId);
    find("[data-basket-picker-select-all]").disabled = busy || !picker.page;
    find("[data-basket-picker-clear]").disabled = busy || !picker.selectedPaths.length;
    find("[data-basket-picker-count]").textContent = picker.selectingAll ? "Selecting files in this folder…" : `${picker.selectedPaths.length} selected`;
    find("[data-basket-picker-add]").disabled = Boolean(mutation) || picker.loading || !picker.selectedPaths.length;
    find("[data-basket-picker-add]").textContent = mutation ? "Linking…" : actionLabel;
    find("[data-basket-path-add]").disabled = Boolean(mutation) || picker.loading;
    find("[data-basket-path-go]").disabled = picker.loading;
  }
  return { render };
}
