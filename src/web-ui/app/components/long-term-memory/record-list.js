import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { renderMemoryIcon } from "./icons.js";
import { renderMemoryRecordEditor } from "./record-editor.js";
import { formatMemoryTimestamp, memoryOriginLabel } from "./view-model.js";

const MEMORY_CONTENT_PREVIEW_CHARACTER_LIMIT = 120;

export function renderMemoryRecordList(view) {
  if (view.loading && view.items.length === 0) {
    return '<div class="memory-management-empty" role="status">Loading memories…</div>';
  }
  if (view.items.length === 0) {
    return `<div class="memory-management-empty">${escapeHtml(view.emptyMessage)}</div>`;
  }
  return `<div class="memory-record-list">${view.items
    .map((record) => renderMemoryRecordWithEditor(record, view))
    .join("")}</div>`;
}

function renderMemoryRecordWithEditor(record, view) {
  const recordMarkup = renderMemoryRecord(record, view);
  const editorMarkup =
    view.editor?.mode === "edit" && view.editor.recordId === record.id
      ? renderMemoryRecordEditor(view)
      : "";
  return `${recordMarkup}${editorMarkup}`;
}

function renderMemoryRecord(record, view) {
  const editing = view.editor?.recordId === record.id;
  const deleting = view.mutation === `delete:${record.id}`;
  const mutationActive = Boolean(view.mutation);
  return `
    <article class="memory-record${editing ? " editing" : ""}" data-memory-record-id="${escapeAttribute(record.id)}">
      <div class="memory-record-copy">
        ${renderContent(record.content)}
        <div class="memory-record-details">
          ${renderTags(record.tags)}
          <div class="memory-record-meta">
            <span>${escapeHtml(memoryOriginLabel(record.origin))}</span>
            <span aria-hidden="true">·</span>
            <time datetime="${escapeAttribute(record.updatedAt)}" title="Created ${escapeAttribute(formatMemoryTimestamp(record.createdAt))}">
              Updated ${escapeHtml(formatMemoryTimestamp(record.updatedAt))}
            </time>
          </div>
        </div>
      </div>
      <div class="memory-record-actions">
        <button
          class="memory-icon-button"
          type="button"
          data-memory-management-action="edit"
          data-memory-id="${escapeAttribute(record.id)}"
          aria-label="Edit memory"
          title="Edit memory"
          ${!view.canWrite || mutationActive ? "disabled" : ""}
        >${renderMemoryIcon("edit")}</button>
        <button
          class="memory-icon-button danger-button"
          type="button"
          data-memory-management-action="delete"
          data-memory-id="${escapeAttribute(record.id)}"
          aria-label="${deleting ? "Deleting memory" : "Delete memory"}"
          title="${deleting ? "Deleting memory" : "Delete memory"}"
          ${mutationActive ? "disabled" : ""}
        >${renderMemoryIcon("delete")}</button>
      </div>
    </article>
  `;
}

function renderContent(content) {
  const collapsible = memoryContentNeedsExpansion(content);
  return `
    <div class="memory-record-content${collapsible ? " collapsible" : ""}">
      <div class="memory-record-content-text">${escapeHtml(content)}</div>
      ${
        collapsible
          ? `<button class="memory-content-toggle" type="button" data-memory-management-action="toggle-content" aria-expanded="false" aria-label="Expand memory" title="Expand memory">${renderMemoryIcon("expand")}</button>`
          : ""
      }
    </div>
  `;
}

function memoryContentNeedsExpansion(content) {
  const value = String(content ?? "");
  const lineCount = value.split(/\r?\n/u).length;
  return lineCount > 2 || value.length > MEMORY_CONTENT_PREVIEW_CHARACTER_LIMIT;
}

function renderTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return "";
  return `<div class="memory-record-tags" aria-label="Tags">${tags
    .map((tag) => `<span>${escapeHtml(tag)}</span>`)
    .join("")}</div>`;
}
