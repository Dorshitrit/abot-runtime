import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import {
  readMemoryEditorInput,
  renderMemoryRecordEditor,
} from "./record-editor.js";
import { renderMemoryIcon } from "./icons.js";
import { renderMemoryRecordList } from "./record-list.js";
import {
  buildMemoryDeleteConfirmation,
  createMemoryManagerView,
} from "./view-model.js";

export function createLongTermMemoryManager({
  actions,
  confirmDelete = (message) => window.confirm(message),
}) {
  let root = null;
  let view = null;
  let focusedEditor = "";

  function mount(nextRoot) {
    if (root === nextRoot) return;
    unbind();
    root = nextRoot;
    root?.addEventListener("click", handleClick);
    root?.addEventListener("submit", handleSubmit);
    root?.addEventListener("keydown", handleKeydown);
    render(actions.snapshot());
  }

  function unbind() {
    root?.removeEventListener("click", handleClick);
    root?.removeEventListener("submit", handleSubmit);
    root?.removeEventListener("keydown", handleKeydown);
  }

  function render(snapshot) {
    view = createMemoryManagerView(snapshot);
    if (!root) return;
    root.innerHTML = managerMarkup(view);
    focusEditorWhenOpened();
  }

  function handleClick(event) {
    const button = event.target.closest("[data-memory-management-action]");
    if (!button) return;
    const action = button.dataset.memoryManagementAction;
    const recordId = button.dataset.memoryId || "";
    if (action === "toggle-content") {
      toggleMemoryContent(button);
      return;
    }
    if (action === "refresh") void actions.refresh();
    if (action === "create") actions.beginCreate();
    if (action === "edit") actions.beginEdit(recordId);
    if (action === "cancel-edit") actions.cancelEdit();
    if (action === "clear-search") void actions.search("");
    if (action === "previous-page") void actions.changePage(-1);
    if (action === "next-page") void actions.changePage(1);
    if (action === "delete") confirmAndDelete(recordId);
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (event.target.matches("[data-memory-search-form]")) {
      const input = root.querySelector("[data-memory-search-input]");
      void actions.search(input?.value || "");
      return;
    }
    if (!event.target.matches("[data-memory-editor]")) return;
    const input = readMemoryEditorInput(root);
    if (input) void actions.save(input);
  }

  function handleKeydown(event) {
    if (event.key !== "Escape" || !view?.editor || view.mutation) return;
    actions.cancelEdit();
  }

  function confirmAndDelete(recordId) {
    const record = view?.items.find((item) => item.id === recordId);
    if (!record) return;
    if (!confirmDelete(buildMemoryDeleteConfirmation(record))) return;
    void actions.deleteMemory(record.id);
  }

  function toggleMemoryContent(button) {
    const record = button.closest("[data-memory-record-id]");
    if (!record) return;
    const expanded = record.classList.toggle("expanded");
    const label = expanded ? "Collapse memory" : "Expand memory";
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
  }

  function focusEditorWhenOpened() {
    const editorKey = view?.editor
      ? `${view.editor.mode}:${view.editor.recordId}`
      : "";
    if (!editorKey) {
      focusedEditor = "";
      return;
    }
    if (editorKey === focusedEditor) return;
    focusedEditor = editorKey;
    queueMicrotask(() =>
      root?.querySelector("[data-memory-editor-content]")?.focus(),
    );
  }

  return Object.freeze({ mount, render });
}

function managerMarkup(view) {
  return `
    <section class="memory-management-card" aria-busy="${view.loading || view.mutation ? "true" : "false"}">
      <div class="memory-management-heading">
        <div>
          <h4>Stored memories</h4>
          <p>Review and control the information ABot can recall across conversations.</p>
        </div>
        <span class="memory-status ${escapeAttribute(view.status.tone)}">${escapeHtml(view.status.label)}</span>
      </div>
      ${availabilityMarkup(view)}
      <div class="memory-management-toolbar">
        <form class="memory-search" role="search" data-memory-search-form>
          <label class="sr-only" for="memoryManagementSearch">Search stored memories</label>
          <div class="memory-search-shell">
            <span class="memory-search-icon">${renderMemoryIcon("search")}</span>
            <input
              id="memoryManagementSearch"
              data-memory-search-input
              type="search"
              value="${escapeAttribute(view.query)}"
              placeholder="Search memories by meaning"
              autocomplete="off"
              ${!view.canWrite || view.busy ? "disabled" : ""}
            />
            <button class="memory-search-submit" type="submit" ${!view.canWrite || view.busy ? "disabled" : ""}>Search</button>
          </div>
          ${view.query ? `<button class="memory-clear-search" type="button" data-memory-management-action="clear-search" ${view.busy ? "disabled" : ""}>Clear</button>` : ""}
        </form>
        <div class="memory-management-primary-actions">
          <button class="memory-icon-button" type="button" data-memory-management-action="refresh" aria-label="Refresh memories" title="Refresh memories" ${view.busy ? "disabled" : ""}>${renderMemoryIcon("refresh")}</button>
          <button class="primary-button memory-add-button" type="button" data-memory-management-action="create" ${!view.canWrite || view.mutation ? "disabled" : ""}>${renderMemoryIcon("add")}<span>Add memory</span></button>
        </div>
      </div>
      ${feedbackMarkup(view)}
      ${detachedEditorMarkup(view)}
      ${renderMemoryRecordList(view)}
      ${paginationMarkup(view)}
    </section>
  `;
}

function detachedEditorMarkup(view) {
  const editorBelongsInList =
    view.editor?.mode === "edit" && Boolean(view.editorRecord);
  return editorBelongsInList ? "" : renderMemoryRecordEditor(view);
}

function availabilityMarkup(view) {
  if (view.enabled === false) {
    return '<p class="memory-management-notice">Memory is disabled. You can still review and delete stored memories.</p>';
  }
  if (view.available === false) {
    return '<p class="memory-management-notice error-text">Memory storage or its embedding provider is unavailable. Existing records remain visible when storage can be read.</p>';
  }
  return "";
}

function feedbackMarkup(view) {
  if (view.error) {
    return `<p class="memory-management-feedback error-text" role="alert">${escapeHtml(view.error)}</p>`;
  }
  return view.message
    ? `<p class="memory-management-feedback" role="status">${escapeHtml(view.message)}</p>`
    : '<div class="sr-only" role="status" aria-live="polite"></div>';
}

function paginationMarkup(view) {
  return `
    <div class="memory-pagination" aria-label="Memory pages">
      <span>${escapeHtml(view.pageLabel)}</span>
      <div>
        <button type="button" data-memory-management-action="previous-page" ${!view.hasPreviousPage || view.busy ? "disabled" : ""}>Previous</button>
        <button type="button" data-memory-management-action="next-page" ${!view.hasNextPage || view.busy ? "disabled" : ""}>Next</button>
      </div>
    </div>
  `;
}
