import { confirmDialog } from "../confirmation-dialog.js";
import { escapeAttribute } from "../../lib/text-format.js";

export function candidateActionsMarkup(candidate, pendingCandidateId = "") {
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1) return "";
  const saving = pendingCandidateId === candidate.id;
  const label = candidate.replacement ? "Update memory" : "Save to memory";
  return `<div class="co-worker-candidate-actions">
    <button type="button" data-candidate-action="promote" data-candidate-id="${escapeAttribute(candidate.id)}" data-candidate-revision="${candidate.revision}"${pendingCandidateId ? " disabled" : ""}>${saving ? "Working…" : label}</button>
    <button type="button" data-candidate-action="delete" data-candidate-id="${escapeAttribute(candidate.id)}" data-candidate-revision="${candidate.revision}"${pendingCandidateId ? " disabled" : ""}>Delete</button>
  </div>`;
}

export async function confirmKnowledgeCandidateAction({ candidate, action, environmentId, isCurrent, actions, confirm = confirmDialog }) {
  if (action !== "promote" && action !== "delete") return;
  const deleting = action === "delete";
  const replacing = !deleting && Boolean(candidate.replacement);
  const copy = candidateConfirmationCopy(deleting, replacing);
  const approved = await confirm(`${copy.message}\n\n${candidate.content}`, {
    title: copy.title, confirmLabel: copy.confirmLabel,
    tone: deleting ? "danger" : "default",
  });
  if (!approved || !isCurrent()) return;
  const binding = { id: candidate.id, revision: candidate.revision, environmentId };
  return deleting ? actions.deleteCandidate(binding) : actions.promoteCandidate(binding);
}

function candidateConfirmationCopy(deleting, replacing) {
  if (deleting) return { title: "Delete candidate", confirmLabel: "Delete candidate",
    message: "Delete this candidate? Saved memories are kept. This cannot be undone." };
  if (replacing) return { title: "Update existing memory", confirmLabel: "Update memory",
    message: "Replace the existing memory with this candidate? The saved memory will be protected from automatic changes." };
  return { title: "Save to memory", confirmLabel: "Save memory",
    message: "Save this candidate as a permanent memory? It will be protected from automatic changes." };
}

export function handleKnowledgeCandidateClick(root, event, actions) {
  const button = event.target.closest?.("button[data-candidate-action]");
  if (!button || !root.contains(button) || button.disabled) return false;
  const snapshot = actions.snapshot();
  const candidate = snapshot.candidates.find(item => item.id === button.dataset.candidateId && item.revision === Number(button.dataset.candidateRevision));
  if (!candidate) return true;
  event.preventDefault();
  void confirmKnowledgeCandidateAction({ candidate, action: button.dataset.candidateAction, environmentId: snapshot.environmentId, actions,
    isCurrent: () => hasCurrentCandidateConfirmation(root, button, actions.snapshot(), snapshot.environmentId, candidate) });
  return true;
}

function hasCurrentCandidateConfirmation(root, button, snapshot, environmentId, candidate) {
  if (!root.contains(button) || snapshot.environmentId !== environmentId) return false;
  if (snapshot.pendingCandidateId) return false;
  return snapshot.candidates.some(item => item.id === candidate.id && item.revision === candidate.revision);
}
