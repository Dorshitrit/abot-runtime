import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { basketIcon } from "./icons.js";
import { createBasketSourcePicker } from "./source-picker.js";
import { createBasketSourceDetails } from "./source-details.js";
import { renderBasketSourceRows } from "./resource-rows.js";
import { createBasketLibraryControls } from "./library-controls.js";

export function createInformationBasketWorkspace({ root, actions, documentRoot = document }) {
  root.innerHTML = `<div class="basket-workspace"><div class="basket-heading"><div><h3>Your information basket</h3><p>Your sources, ready for every conversation.</p></div><span class="basket-scope">Personal · All chats</span></div>
    <section class="basket-drop" aria-label="Add source files" data-basket-drop><div class="basket-drop-art" aria-hidden="true"><span>${basketIcon("file")}</span>${basketIcon("basket")}</div><div class="basket-drop-copy"><h3>Drop your sources here</h3><p>Documents, notes, and the things you work with.</p><span>Original files stay where they are.</span></div><div class="basket-drop-actions"><button type="button" class="primary-button" data-basket-choose>${basketIcon("folder")} Choose files</button><span>or drag a file here</span></div></section>
    <section class="basket-settings" aria-label="Resource indexing settings">
      <div class="basket-settings-heading"><span class="basket-settings-icon" aria-hidden="true">${basketIcon("index")}</span><div><h4>Resource indexing</h4><p>Choose how your sources become searchable.</p></div><label class="basket-enabled"><span>Enable resources</span><input type="checkbox" role="switch" data-basket-enabled></label></div>
      <div class="basket-settings-controls"><label class="basket-profile-label">Embedding profile<select data-basket-profile aria-label="Embedding profile"></select></label><div class="basket-settings-actions"><span class="basket-settings-pending" data-basket-settings-pending hidden>Unsaved changes</span><button type="button" class="basket-text-button" data-basket-settings-reset hidden>Reset changes</button><button type="button" class="primary-button" data-basket-settings-save>Save settings</button></div></div>
      <p class="basket-note basket-formats" data-basket-formats></p>
    </section>
    <p class="basket-feedback" role="alert" data-basket-error hidden></p><p class="basket-feedback" role="status" aria-live="polite" data-basket-message hidden></p>
    <section class="basket-library" aria-label="Indexed resources"><div class="basket-library-heading"><div><h3>Your sources <span data-basket-count></span></h3><p>Manage the files available across your chats.</p></div><button type="button" class="basket-refresh" data-basket-refresh>${basketIcon("refresh")}<span>Refresh</span></button></div><div class="basket-toolbar" data-basket-library-controls></div>
    <div class="basket-bulk" data-basket-bulk hidden><span data-basket-selection-count></span><div><button type="button" class="basket-text-button" data-basket-bulk-index>Re-index</button><button type="button" class="basket-text-button basket-remove" data-basket-bulk-remove>Remove from basket</button></div></div>
    <div class="basket-table-wrap"><table class="basket-table"><thead><tr><th class="basket-check-cell"><input type="checkbox" data-basket-select-all aria-label="Select all visible sources"></th><th>Source</th><th>Status</th><th class="basket-time-cell">Last indexed</th><th><span class="basket-accessible-label">Actions</span></th></tr></thead><tbody data-basket-rows></tbody></table></div><p class="basket-empty" data-basket-empty hidden></p><div class="basket-table-footer"><span data-basket-shown></span></div></section>
    </div>`;
  const find = (selector) => root.querySelector(selector);
  const libraryControls = createBasketLibraryControls({ root: find("[data-basket-library-controls]"), actions });
  const picker = createBasketSourcePicker({ root, actions: actions.picker, documentRoot });
  const details = createBasketSourceDetails({ root, close: () => actions.showDetails(""), documentRoot });
  let current;
  let rowsMarkup = "";
  let profilesMarkup = "";
  const selectedIds = () => current?.selected || [];
  root.addEventListener("click", (event) => {
    const button = event.target.closest?.("button");
    if (!button || button.closest(".basket-picker-dialog")) return;
    if (button.hasAttribute("data-basket-choose")) void actions.picker.open();
    if (button.hasAttribute("data-basket-refresh")) void actions.refresh();
    if (button.hasAttribute("data-basket-settings-save")) void actions.saveSettings();
    if (button.hasAttribute("data-basket-settings-reset")) actions.resetSettings();
    if (button.hasAttribute("data-basket-detail")) actions.showDetails(button.dataset.basketDetail);
    if (button.hasAttribute("data-basket-link")) actions.link(button.dataset.basketLink);
    if (button.hasAttribute("data-basket-reindex")) void actions.reindex([button.dataset.basketReindex]);
    if (button.hasAttribute("data-basket-remove")) void actions.remove([button.dataset.basketRemove]);
    if (button.hasAttribute("data-basket-bulk-index")) void actions.reindex(selectedIds());
    if (button.hasAttribute("data-basket-bulk-remove")) void actions.remove(selectedIds());
  });
  find("[data-basket-enabled]").addEventListener("change", (event) => actions.changeSettings("enabled", event.target.checked));
  find("[data-basket-profile]").addEventListener("change", (event) => actions.changeSettings("embeddingProfileId", event.target.value || null));
  root.addEventListener("change", (event) => {
    if (event.target.hasAttribute?.("data-basket-select-all")) actions.selectVisible(event.target.checked);
    if (event.target.hasAttribute?.("data-basket-select")) actions.select(event.target.dataset.basketSelect, event.target.checked);
  });
  const drop = find("[data-basket-drop]");
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("is-dragging");
    if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
  });
  drop.addEventListener("dragleave", (event) => {
    if (drop.contains(event.relatedTarget)) return;
    drop.classList.remove("is-dragging");
  });
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-dragging");
    actions.receiveDrop(event.dataTransfer?.files || []);
  });
  function renderSettings(snapshot) {
    const { settingsDraft: settings, view } = snapshot;
    const profiles = view?.embeddingProfiles || [];
    const currentId = settings?.embeddingProfileId || "";
    const currentMissing = currentId && !profiles.some((profile) => profile.id === currentId);
    const nextProfiles = `<option value="">${profiles.length ? "Select an embedding profile" : "No saved embedding profiles"}</option>` +
      (currentMissing ? `<option value="${escapeAttribute(currentId)}">Unavailable profile: ${escapeHtml(currentId)}</option>` : "") +
      profiles.map((profile) => `<option value="${escapeAttribute(profile.id)}">${escapeHtml(profile.label)} · ${escapeHtml(profile.model)}</option>`).join("");
    if (profilesMarkup !== nextProfiles) { find("[data-basket-profile]").innerHTML = nextProfiles; profilesMarkup = nextProfiles; }
    find("[data-basket-profile]").value = currentId;
    find("[data-basket-profile]").disabled = !view || Boolean(snapshot.mutation);
    find("[data-basket-enabled]").checked = settings?.enabled === true;
    find("[data-basket-enabled]").disabled = !view || Boolean(snapshot.mutation);
    find("[data-basket-settings-save]").disabled = !snapshot.settingsDirty || Boolean(snapshot.mutation);
    find("[data-basket-settings-reset]").hidden = !snapshot.settingsDirty;
    find("[data-basket-settings-pending]").hidden = !snapshot.settingsDirty;
    find("[data-basket-settings-reset]").disabled = Boolean(snapshot.mutation);
    const formats = (view?.supportedExtensions || []).join(", ");
    find("[data-basket-formats]").textContent = formats ? `Supported files: ${formats}` : "Loading supported formats…";
  }
  function render(snapshot) {
    current = snapshot;
    renderSettings(snapshot);
    libraryControls.render(snapshot);
    const nextRows = renderBasketSourceRows(snapshot);
    if (nextRows !== rowsMarkup) { find("[data-basket-rows]").innerHTML = nextRows; rowsMarkup = nextRows; }
    for (const checkbox of root.querySelectorAll("[data-basket-select]")) checkbox.checked = snapshot.selected.includes(checkbox.dataset.basketSelect);
    const selectedVisible = snapshot.visibleSources.filter((source) => snapshot.selected.includes(source.sourceId)).length;
    const selectAll = find("[data-basket-select-all]");
    selectAll.checked = snapshot.visibleSources.length > 0 && selectedVisible === snapshot.visibleSources.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < snapshot.visibleSources.length;
    selectAll.disabled = Boolean(snapshot.mutation) || !snapshot.visibleSources.length;
    find("[data-basket-rows]").setAttribute("aria-busy", String(snapshot.loading));
    find("[data-basket-count]").textContent = String(snapshot.sources.length);
    find("[data-basket-shown]").textContent = `${snapshot.visibleSources.length} of ${snapshot.sources.length} sources`;
    find("[data-basket-bulk]").hidden = !snapshot.selected.length;
    find("[data-basket-selection-count]").textContent = `${snapshot.selected.length} selected`;
    find("[data-basket-bulk-index]").disabled = Boolean(snapshot.mutation);
    find("[data-basket-bulk-remove]").disabled = Boolean(snapshot.mutation);
    find("[data-basket-choose]").disabled = !snapshot.view || Boolean(snapshot.mutation);
    find("[data-basket-refresh]").disabled = snapshot.loading || Boolean(snapshot.mutation);
    find("[data-basket-empty]").hidden = Boolean(snapshot.visibleSources.length);
    find("[data-basket-empty]").textContent = snapshot.loading ? "Loading sources…" : snapshot.sources.length ? "No sources match this view." : "No sources yet. Link files to make them available across your chats.";
    for (const [selector, value] of [["[data-basket-error]", snapshot.error], ["[data-basket-message]", snapshot.message]]) {
      find(selector).textContent = value; find(selector).hidden = !value;
    }
    details.render(snapshot.detail);
    picker.render(snapshot.picker, snapshot.mutation);
  }
  return { render };
}
