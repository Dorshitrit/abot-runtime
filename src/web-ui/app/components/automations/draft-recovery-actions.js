import { escapeHtml } from "../../lib/text-format.js";
import { renderAutomationEditorIcon } from "./editor-action-icons.js";

export function renderAutomationDraftRecovery(snapshot) {
  const undo = snapshot.draftUndo;
  const undoTitle = undo ? `Undo the latest move of ${undo.title}. ${undo.count} saved move${undo.count === 1 ? "" : "s"} can be undone.`
    : "Move a step to enable Undo. Move history is kept during this session.";
  const published = snapshot.publishedDefinition;
  const canRestore = published?.automationId === snapshot.selectedAutomationId &&
    Number.isSafeInteger(published?.revision);
  return `<button type="button" class="automation-editor-action" data-action="undo-draft-move" title="${escapeHtml(undoTitle)}"${!undo || snapshot.mutation ? " disabled" : ""}>${renderAutomationEditorIcon("undo")}<span>Undo move</span></button>
    ${canRestore ? `<button type="button" class="automation-editor-action" data-action="restore-published-draft"${snapshot.mutation ? " disabled" : ""}>${renderAutomationEditorIcon("restore")}<span>Reset draft to published</span></button>` : ""}`;
}

export function createAutomationDraftRecoveryCommands({ actions, requireSavedGraph,
  confirmDiscard, onRestored }) {
  return {
    "undo-draft-move": () => { if (requireSavedGraph()) return actions.undoDraftMove(); },
    "restore-published-draft": async () => {
      if (!requireSavedGraph()) return false;
      const restored = await actions.restorePublishedDraft(({ title, publishedRevision }) => confirmDiscard(
        `Replace the current draft of “${title}” with published revision ${publishedRevision}? Unpublished draft changes will be discarded. The published version, schedule, permissions, and existing runs will stay unchanged.`,
        { title: "Reset draft", confirmLabel: "Reset draft", tone: "danger" },
      ));
      if (restored) onRestored();
      return restored;
    },
  };
}
