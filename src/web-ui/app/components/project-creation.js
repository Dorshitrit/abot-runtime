import { escapeHtml, escapeAttribute } from "../lib/text-format.js";

function renderFolderPicker(draft) {
  if (!draft.pickerOpen) return "";
  const listing = draft.listing;
  const entries = listing?.entries ?? [];
  const selectionDisabled = draft.loading || !listing || draft.error;
  return `
    <section id="project-folder-picker" class="project-folder-browser" role="region" aria-labelledby="project-folder-heading" aria-busy="${draft.loading}" tabindex="-1">
      <div class="project-folder-heading"><span id="project-folder-heading">Choose a folder</span>${listing?.parent ? '<button type="button" data-parent>Up one folder</button>' : ""}</div>
      <p class="project-folder-location" dir="ltr">${escapeHtml(listing?.directory || draft.directory)}</p>
      <div class="project-folder-roots">${(listing?.roots ?? []).map((entry, index) => `<button type="button" data-root="${index}" title="${escapeAttribute(entry.path)}">${escapeHtml(entry.label)}</button>`).join("")}</div>
      <div class="project-folder-entries">${entries.map((entry, index) => `<button type="button" data-folder="${index}" title="${escapeAttribute(entry.path)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v13H3Z"/></svg><span dir="auto">${escapeHtml(entry.name)}</span><span aria-hidden="true">›</span></button>`).join("")}</div>
      ${draft.loading ? '<p role="status">Loading folders…</p>' : ""}
      ${!draft.loading && listing && entries.length === 0 ? "<p>This folder has no subfolders.</p>" : ""}
      ${listing?.nextCursor ? '<button type="button" data-more>Load more folders</button>' : ""}
      <div class="project-folder-actions"><button type="button" data-cancel-picker>Cancel</button><button type="button" data-select-folder ${selectionDisabled ? "disabled" : ""}>Use this folder</button></div>
    </section>`;
}

export function createProjectCreation({ root, actions }) {
  let wasPickerOpen = false;
  function render(draft) {
    root.hidden = !draft;
    if (!draft) {
      wasPickerOpen = false;
      root.replaceChildren();
      return;
    }
    const activeInput = root.ownerDocument?.activeElement;
    const activeField =
      activeInput && root.contains(activeInput) ? activeInput?.name : "";
    const hadPickerFocus = Boolean(activeInput?.closest?.(".project-folder-browser"));
    const pickerOpened = draft.pickerOpen && !wasPickerOpen;
    const pickerClosed = !draft.pickerOpen && wasPickerOpen;
    wasPickerOpen = draft.pickerOpen;
    const selectionStart = activeInput?.selectionStart;
    const selectionEnd = activeInput?.selectionEnd;
    const disabled = draft.saving ? "disabled" : "";
    const listing = draft.listing;
    const entries = listing?.entries ?? [];
    root.innerHTML = `
      <form class="project-create-form">
        <header><h2>Create a project</h2><p>Choose a folder for this project's conversations.</p></header>
        <label>Project name <input name="name" maxlength="120" autocomplete="off" value="${escapeAttribute(draft.name)}" placeholder="Folder name" ${disabled}></label>
        <label>Working folder <span class="project-path-input"><input name="directory" required autocomplete="off" spellcheck="false" value="${escapeAttribute(draft.directory)}" placeholder="Absolute folder path" ${disabled}><button type="button" data-browse aria-expanded="${draft.pickerOpen}" aria-controls="project-folder-picker" ${disabled}>Browse</button></span></label>
        ${renderFolderPicker(draft)}
        ${draft.error ? `<p class="error-text" role="alert">${escapeHtml(draft.error)}</p>` : ""}
        <footer><button type="button" data-cancel ${disabled}>Cancel</button><button type="submit" class="project-create-submit" ${draft.saving || draft.loading || draft.pickerOpen ? "disabled" : ""}>${draft.saving ? "Creating…" : "Create project"}</button></footer>
      </form>`;
    root.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      void actions.create();
    });
    root.querySelector("form").addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!draft.pickerOpen) return;
      event.preventDefault();
      event.stopPropagation();
      actions.cancelFolderPicker();
    });
    for (const field of ["name", "directory"]) {
      root
        .querySelector(`[name="${field}"]`)
        .addEventListener("input", (event) =>
          actions.updateDraft(field, event.target.value),
        );
    }
    root
      .querySelector("[data-browse]")
      .addEventListener("click", () => void actions.openFolderPicker());
    root
      .querySelector("[data-cancel]")
      .addEventListener("click", actions.closeCreate);
    root.querySelector("[data-cancel-picker]")
      ?.addEventListener("click", actions.cancelFolderPicker);
    root.querySelector("[data-select-folder]")
      ?.addEventListener("click", actions.selectFolder);
    root
      .querySelector("[data-parent]")
      ?.addEventListener("click", () => void actions.browse(listing.parent));
    root
      .querySelector("[data-more]")
      ?.addEventListener(
        "click",
        () => void actions.browse(listing.directory, listing.nextCursor),
      );
    for (const button of root.querySelectorAll("[data-root]")) {
      button.addEventListener(
        "click",
        () =>
          void actions.browse(listing.roots[Number(button.dataset.root)].path),
      );
    }
    for (const button of root.querySelectorAll("[data-folder]")) {
      button.addEventListener(
        "click",
        () => void actions.browse(entries[Number(button.dataset.folder)].path),
      );
    }
    for (const button of root.querySelectorAll(
      "[data-parent], [data-more], [data-root], [data-folder]",
    ))
      button.disabled = draft.saving || draft.loading;
    if (["name", "directory"].includes(activeField)) {
      const input = root.querySelector(`[name="${activeField}"]`);
      input?.focus();
      input?.setSelectionRange(selectionStart, selectionEnd);
      return;
    }
    if (pickerClosed) {
      root.querySelector("[data-browse]")?.focus();
      return;
    }
    if (pickerOpened || hadPickerFocus)
      root.querySelector(".project-folder-browser")?.focus();
  }
  return { render };
}
