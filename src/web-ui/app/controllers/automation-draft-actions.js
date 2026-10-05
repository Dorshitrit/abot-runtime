import { findAutomationNode } from "../components/automations/timeline.js";
import { findAutomationPosition } from "../lib/automation-graph-position.js";

const MAX_UNDO_MOVES = 20;

function inverseMove(before, after, change) {
  if (change.kind !== "move_node") return null;
  const previous = findAutomationPosition(before.body, change.nodeId);
  const current = findAutomationPosition(after.body, change.nodeId);
  if (!previous || !current) return null;
  const sameParent = previous.parentSequenceId === current.parentSequenceId;
  if (sameParent && previous.index === current.index) return null;
  // move_node indexes refer to the destination before removing the source.
  const removalOffset = sameParent && current.index < previous.index ? 1 : 0;
  return { kind: "move_node", nodeId: change.nodeId,
    parentSequenceId: previous.parentSequenceId, index: previous.index + removalOffset };
}

/** Session-only inverse moves; every write still uses the revisioned draft API. */
export function createAutomationDraftActions({ state, client, mutation, publish,
  loadList, currentEnvironment, captureView }) {
  const history = [];

  function currentUndo() {
    const latest = history.at(-1);
    if (!latest) return null;
    if (!currentEnvironment(latest.environmentId)) { history.length = 0; return null; }
    if (state.selectedAutomationId !== latest.automationId || !state.draft) return null;
    if (state.draft.revision !== latest.expectedRevision) { history.length = 0; return null; }
    return latest;
  }

  function undoState() {
    const latest = currentUndo();
    if (!latest) return null;
    return { count: history.length, title: latest.title };
  }

  function captureScope() {
    return { ...captureView(), revision: state.draft?.revision };
  }

  function ownsView(scope) {
    return scope.isCurrent();
  }

  function recordMutation(before, after, change, scope, undo) {
    if (undo) {
      history.pop();
      const next = history.at(-1);
      if (next) next.expectedRevision = after.revision;
      return;
    }
    const inverse = inverseMove(before, after.definition, change);
    if (!inverse) { history.length = 0; return; }
    const latest = history.at(-1);
    const continuesHistory = latest && latest.automationId === scope.automationId &&
      latest.environmentId === scope.environmentId && latest.expectedRevision === scope.revision;
    if (!continuesHistory) history.length = 0;
    history.push({ ...scope, expectedRevision: after.revision, inverse,
      title: findAutomationNode(before.body, change.nodeId)?.title || "Step" });
    if (history.length > MAX_UNDO_MOVES) history.shift();
  }

  async function commit(change, { scope = captureScope(), undo = false,
    feedback = "Draft saved." } = {}) {
    if (!scope.automationId || !Number.isInteger(scope.revision) || !ownsView(scope)) return false;
    if (state.draft?.revision !== scope.revision) return false;
    currentUndo();
    const before = state.draft.definition;
    const response = await mutation("Draft", () => client.mutateAutomationDraft(
      scope.automationId, scope.revision, change, scope.environmentId), feedback, () => ownsView(scope));
    if (!response?.draft || !ownsView(scope)) return false;
    const continuation = scope.captureContinuation();
    state.draft = response.draft;
    recordMutation(before, response.draft, change, scope, undo);
    if (change.kind === "add_node") {
      const parent = findAutomationNode(response.draft.definition?.body, change.parentSequenceId);
      const added = parent?.children?.[change.index];
      if (added?.kind === "agent" || added?.kind === "tool") state.selectedNodeId = added.id;
    }
    if (change.kind === "restore_published") state.selectedNodeId = "";
    state.validation = null;
    state.validationVisible = false;
    await loadList(continuation.isCurrent);
    if (!continuation.isCurrent()) return false;
    publish();
    return true;
  }

  function mutateDraft(change) {
    const feedback = change.kind === "move_node"
      ? "Step order saved to the draft. Use Undo move to reverse it. Publishing is separate."
      : "Draft saved.";
    return commit(change, { feedback });
  }

  async function undoDraftMove() {
    if (state.mutation) return false;
    const latest = currentUndo();
    if (!latest) return false;
    return commit(latest.inverse, { undo: true,
      feedback: "Previous step order restored in the draft. Publishing is separate." });
  }

  async function restorePublishedDraft(confirm) {
    if (state.mutation) return false;
    const scope = captureScope();
    const published = state.publishedDefinition;
    if (!scope.automationId || !Number.isSafeInteger(scope.revision) || !published ||
        published.automationId !== scope.automationId || !Number.isSafeInteger(published.revision) ||
        typeof confirm !== "function") return false;
    const confirmed = await confirm({ title: state.draft.definition.title, publishedRevision: published.revision });
    if (confirmed !== true || !ownsView(scope)) return false;
    const unchanged = state.draft?.revision === scope.revision &&
      state.publishedDefinition?.revision === published.revision;
    if (!unchanged) {
      state.error = "The draft or published revision changed. Review it before resetting the draft.";
      publish();
      return false;
    }
    return commit({ kind: "restore_published", publishedRevision: published.revision }, {
      scope, feedback: "The draft now matches the published version. The published automation is unchanged.",
    });
  }

  async function saveDefinition(patch) {
    const definition = state.draft?.definition;
    if (!definition) return false;
    if (Object.keys(patch).every((key) => JSON.stringify(patch[key]) === JSON.stringify(definition[key]))) {
      state.feedback = "Draft is already up to date.";
      publish();
      return true;
    }
    return mutateDraft({ kind: "update_definition", patch });
  }

  async function saveNode(nodeId, patch) {
    const node = findAutomationNode(state.draft?.definition?.body, nodeId);
    if (!node) return false;
    const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) =>
      JSON.stringify(value) !== JSON.stringify(node[key])));
    if (!Object.keys(changed).length) {
      state.feedback = "Step is already up to date.";
      publish();
      return true;
    }
    return mutateDraft({ kind: "update_node", nodeId, patch: changed });
  }

  return { mutateDraft, saveDefinition, saveNode, undoDraftMove, restorePublishedDraft, undoState,
    clearUndo: () => { history.length = 0; } };
}
