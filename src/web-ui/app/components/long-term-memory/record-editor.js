import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { renderMemoryIcon } from "./icons.js";
import { parseMemoryTags } from "./view-model.js";

export function renderMemoryRecordEditor(view) {
  if (!view.editor) return "";
  const editing = view.editor.mode === "edit";
  const record = editing ? view.editorRecord : null;
  if (editing && !record) {
    return `
      <section class="memory-editor-card" role="alert">
        <p>This memory is no longer in the current result set.</p>
        <button class="memory-editor-dismiss" type="button" data-memory-management-action="cancel-edit">Close</button>
      </section>
    `;
  }
  const busy = view.mutation === view.editor.mode;
  const content = view.editor.draft?.content ?? record?.content ?? "";
  const tags = view.editor.draft?.tags ?? record?.tags ?? [];
  return `
    <form class="memory-editor-card" data-memory-editor>
      <div class="memory-editor-heading">
        <div>
          <h5>${editing ? "Update stored memory" : "Add a memory"}</h5>
          <p>${editing ? "Refine what ABot should recall." : "Store a fact that should be available in future conversations."}</p>
        </div>
        <button class="memory-icon-button" type="button" data-memory-management-action="cancel-edit" aria-label="Close memory editor" title="Close memory editor" ${busy ? "disabled" : ""}>${renderMemoryIcon("close")}</button>
      </div>
      <label>
        <span>What should ABot remember?</span>
        <textarea data-memory-editor-content rows="3" required ${busy ? "disabled" : ""}>${escapeHtml(content)}</textarea>
      </label>
      <label>
        <span>Tags <small>Separate with commas</small></span>
        <input data-memory-editor-tags type="text" value="${escapeAttribute(
          Array.isArray(tags) ? tags.join(", ") : "",
        )}" ${busy ? "disabled" : ""} />
      </label>
      <div class="memory-editor-actions">
        <button class="primary-button" type="submit" ${busy ? "disabled" : ""}>
          ${busy ? "Saving…" : editing ? "Save changes" : "Add memory"}
        </button>
      </div>
    </form>
  `;
}

export function readMemoryEditorInput(root) {
  const contentInput = root.querySelector("[data-memory-editor-content]");
  const tagsInput = root.querySelector("[data-memory-editor-tags]");
  const content = String(contentInput?.value ?? "").trim();
  if (!content) {
    contentInput?.setCustomValidity("Enter something for ABot to remember.");
    contentInput?.reportValidity();
    return null;
  }
  contentInput?.setCustomValidity("");
  return Object.freeze({
    content,
    tags: Object.freeze(parseMemoryTags(tagsInput?.value)),
  });
}
