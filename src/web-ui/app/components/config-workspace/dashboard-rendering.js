import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

export function createConfigDashboardRendering({
  state,
  configFileEntries,
  configFileKey,
  ensureRawSelection,
  fileStatusText,
  hasRawDraftChanges,
  isFileDirty,
  rawDraftFor,
  selectedRawConfigFile,
}) {
  function rawConfigStatusText(file, rawDraftIsDirty) {
    if (!file) return "No config files";
    if (rawDraftIsDirty) return "Draft not applied";
    return fileStatusText(file);
  }

  function renderRawConfigPanel() {
    const files = configFileEntries();
    ensureRawSelection(files);
    const file = selectedRawConfigFile();
    const rawDirty = file ? hasRawDraftChanges(file) : false;
    const fileDirty = file ? isFileDirty(file) : false;
    const pending = rawDirty || fileDirty;
    const saving = file ? state.savingKeys.has(configFileKey(file)) : false;
    const status = rawConfigStatusText(file, rawDirty);
    return `
      <details
        id="configRawPanel"
        class="config-raw-panel"
        ${state.rawPanelOpen ? "open" : ""}
      >
        <summary>Raw JSON</summary>
        <div class="config-raw-toolbar">
          <label class="config-raw-file-select">
            <span>Config file</span>
            <select id="configRawFileSelect" title="Config file" ${
              file ? "" : "disabled"
            }>
              ${files
                .map(
                  (item) =>
                    `<option value="${escapeAttribute(configFileKey(item))}" ${
                      configFileKey(item) === state.selectedRawConfigKey
                        ? "selected"
                        : ""
                    }>${escapeHtml(item.label)}</option>`,
                )
                .join("")}
            </select>
          </label>
          <span
            class="config-raw-status ${pending ? "dirty" : ""}"
            role="status"
            aria-live="polite"
          >${escapeHtml(status)}</span>
          <div class="config-file-actions">
            <button
              id="configApplyRawButton"
              type="button"
              data-config-action="apply-raw"
              ${rawDirty && !saving ? "" : "disabled"}
            >Apply draft</button>
            <button
              type="button"
              data-config-action="reset-file"
              data-kind="${escapeAttribute(file?.kind || "")}"
              data-id="${escapeAttribute(file?.id || "")}"
              ${pending && !saving ? "" : "disabled"}
            >Reset</button>
            <button
              id="configSaveRawButton"
              type="button"
              data-config-action="save-raw"
              ${pending && !saving ? "" : "disabled"}
            >Save file</button>
          </div>
        </div>
        <textarea
          id="configRawEditor"
          class="config-view"
          aria-label="Raw JSON configuration"
          spellcheck="false"
          ${file ? "" : "disabled"}
        >${escapeHtml(file ? rawDraftFor(file) : "")}</textarea>
      </details>
    `;
  }

  function renderConfigMap() {
    return `
      <section class="config-section config-files-section">
        <div class="config-section-header">
          <div class="config-file-meta">
            <h3>Config files</h3>
            <p>Files linked by the active runtime configuration.</p>
          </div>
        </div>
        <div class="config-file-list">
          ${configFileEntries()
            .map(
              (file) => `
                <div class="config-file-row">
                  <span>${escapeHtml(file.label)}</span>
                  <code>${escapeHtml(file.path)}</code>
                </div>
              `,
            )
            .join("")}
        </div>
      </section>
      ${renderRawConfigPanel()}
    `;
  }

  function renderCategoryTab(category, label) {
    const active = state.activeCategory === category;
    return `
      <button
        id="configCategory${category[0].toUpperCase()}${category.slice(1)}"
        class="config-category-tab ${active ? "active" : ""}"
        type="button"
        role="tab"
        data-config-action="select-category"
        data-config-category="${escapeAttribute(category)}"
        aria-controls="config${category[0].toUpperCase()}${category.slice(1)}Panel"
        aria-selected="${active ? "true" : "false"}"
        tabindex="${active ? "0" : "-1"}"
      >${escapeHtml(label)}</button>
    `;
  }

  function renderCategoryPanel(category, content) {
    const capitalized = `${category[0].toUpperCase()}${category.slice(1)}`;
    const active = state.activeCategory === category;
    return `
      <section
        id="config${capitalized}Panel"
        class="config-category-panel ${active ? "active" : ""}"
        role="tabpanel"
        aria-labelledby="configCategory${capitalized}"
        data-config-category-panel="${escapeAttribute(category)}"
        ${active ? "" : "hidden"}
      >${content}</section>
    `;
  }

  return {
    renderCategoryPanel,
    renderCategoryTab,
    renderConfigMap,
  };
}
