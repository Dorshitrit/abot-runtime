import { confirmDialog } from "../confirmation-dialog.js";
import { automationRerunConfirmation } from "./rerun-confirmation.js";

function automationConfirmationIdentity(snapshot) {
  const selected = snapshot.automations?.find((item) => item.id === snapshot.selectedAutomationId);
  return JSON.stringify([snapshot.selectedAutomationId, snapshot.selectedRunId, snapshot.selectedNodeId,
    snapshot.draft?.revision, snapshot.publishedDefinition?.revision, selected?.publishedRevision,
    selected?.status, snapshot.run?.id, snapshot.run?.status, snapshot.mutation]);
}

/** An approval belongs to the exact view, revision and local edits that requested it. */
export function captureAutomationConfirmationScope({ actions, getCurrent, getEditRevision = () => 0 }) {
  const ownsView = actions.captureActionScope?.() || (() => true);
  const identity = automationConfirmationIdentity(getCurrent());
  const editRevision = getEditRevision();
  return () => {
    if (!ownsView()) return false;
    if (editRevision !== getEditRevision()) return false;
    return identity === automationConfirmationIdentity(getCurrent());
  };
}

export function createAutomationConfirmations({ actions, getCurrent, getEditRevision, confirm = confirmDialog }) {
  let requestRevision = 0;
  async function prepare(message, options, operation) {
    const revision = ++requestRevision;
    const ownsScope = captureAutomationConfirmationScope({ actions, getCurrent, getEditRevision });
    const isCurrent = () => revision === requestRevision && ownsScope();
    let approved;
    try { approved = await confirm(message, options); }
    catch { return false; }
    if (approved !== true || !isCurrent()) return false;
    const commit = () => isCurrent() ? operation() : false;
    commit.canCommit = isCurrent;
    return commit;
  }
  return {
    invalidate() { requestRevision += 1; },
    prepare,
    async run(message, options, operation) {
      const commit = await prepare(message, options, operation);
      return commit ? commit() : false;
    },
  };
}

export function createAutomationDestructiveCommands({ actions, getCurrent, requireSavedGraph,
  confirmations, onDraftDeleted }) {
  return {
    "remove-node": () => {
      if (!requireSavedGraph()) return false;
      const nodeId = getCurrent().selectedNodeId;
      return confirmations.run("Remove this step from the draft?",
        { title: "Remove step", confirmLabel: "Remove", tone: "danger" }, async () => {
          const removed = await actions.mutateDraft({ kind: "remove_node", nodeId });
          if (removed) actions.selectNode("");
          return removed;
        });
    },
    "delete-draft": () => {
      const current = getCurrent();
      if (!current.draft || current.publishedDefinition) return false;
      if (current.automations.find((item) => item.id === current.selectedAutomationId)?.publishedRevision) return false;
      return confirmations.run("Delete this unpublished automation draft and all its steps? This cannot be undone.",
        { title: "Delete draft", confirmLabel: "Delete", tone: "danger" }, async () => {
          const deleted = await actions.deleteDraft();
          if (deleted) onDraftDeleted();
          return deleted;
        });
    },
    rerun: () => {
      const run = getCurrent().run;
      if (!run) return false;
      return confirmations.run(automationRerunConfirmation(run),
        { title: "Run automation again", confirmLabel: "Run again" }, () => actions.rerun());
    },
  };
}
