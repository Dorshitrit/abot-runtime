import { escapeHtml } from "../../lib/text-format.js";
import { renderAutomationDraftRecovery } from "./draft-recovery-actions.js";
import { renderAutomationEditorIcon } from "./editor-action-icons.js";

function editorAction(action, label, icon, { className = "", disabled = false, busy = false, title = "" } = {}) {
  return `<button type="button" class="automation-editor-action ${className}" data-action="${action}"${disabled ? " disabled" : ""}${busy ? ' aria-busy="true"' : ""}${title ? ` title="${escapeHtml(title)}"` : ""}>${renderAutomationEditorIcon(icon)}<span>${label}</span></button>`;
}

function renderDraftActions() {
  return `<div class="automation-editor-action-group" role="group" aria-label="Draft actions">
    <span class="automation-editor-action-label">Draft</span><div class="automation-actions">
      ${editorAction("save-draft", "Save draft", "save", { title: "Save automation settings to the draft" })}
      ${editorAction("describe", "Build with ABot", "build")}
      ${editorAction("validate", "Check", "check", { title: "Check the draft before publishing" })}
      ${editorAction("publish", "Publish", "publish", { className: "automation-primary", title: "Publish this draft for future runs" })}
    </div></div>`;
}

function renderExecutionActions(snapshot, current, runUnavailable, activateUnavailable) {
  const active = current.status === "active";
  const runPending = Boolean(snapshot.runStartPending);
  const runActionDisabled = runUnavailable || runPending || snapshot.loading || Boolean(snapshot.mutation);
  return `<div class="automation-editor-action-group automation-editor-execution" role="group" aria-label="Execution actions">
    <span class="automation-editor-action-label">Execution <span class="automation-editor-state" data-state="${active ? "active" : "paused"}">${active ? "Active" : "Paused"}</span></span>
    <div class="automation-actions">
      ${editorAction("run", runPending ? "Starting…" : "Run now", "run", { disabled: runActionDisabled, busy: runPending,
        title: runUnavailable ? current.runUnavailableReason || "Run unavailable" : "Run the published version once" })}
      ${editorAction("toggle-active", active ? "Pause" : "Activate", active ? "pause" : "activate", {
        className: active ? "automation-editor-pause" : "automation-editor-activate", disabled: activateUnavailable,
        title: activateUnavailable ? current.activateUnavailableReason || "Activation unavailable"
          : active ? "Pause automatic triggers" : "Enable automatic triggers for the published version" })}
    </div></div>`;
}

function renderManagementActions(snapshot, published, canDeleteDraft) {
  const archive = published ? editorAction("archive", "Archive automation", "archive", { className: "automation-editor-archive" })
    : canDeleteDraft ? editorAction("delete-draft", "Delete draft", "delete", { className: "automation-stop" }) : "";
  return `<details class="automation-editor-management"><summary>${renderAutomationEditorIcon("manage")}<span>Manage automation</span></summary>
    <div class="automation-editor-management-body">
      <div class="automation-editor-action-group" role="group" aria-label="Draft recovery">
        <span class="automation-editor-action-label">Draft recovery</span><div class="automation-actions">${renderAutomationDraftRecovery(snapshot)}</div>
      </div>
      ${archive ? `<div class="automation-editor-archive-group"><span class="automation-editor-action-label">${published ? "Archive" : "Delete draft"}</span><div class="automation-actions">${archive}</div>
        <p>${published ? "Pause its schedule and move it to the archive. Runs and reports stay available." : "Permanently remove this unpublished draft."}</p></div>` : ""}
    </div></details>`;
}

export function renderAutomationEditorActions(snapshot, { current, canDeleteDraft, runUnavailable, activateUnavailable }) {
  if (current?.status === "archived") {
    return `<div class="automation-editor-actionbar automation-actions">${editorAction("restore", "Restore automation", "restore", { className: "automation-primary" })}</div>`;
  }
  const published = Boolean(current?.publishedRevision);
  return `<div class="automation-editor-actionbar" aria-label="Automation actions">
    <div class="automation-editor-action-groups">${renderDraftActions()}${published ? renderExecutionActions(snapshot, current, runUnavailable, activateUnavailable) : ""}</div>
    ${renderManagementActions(snapshot, published, canDeleteDraft)}
  </div>`;
}
