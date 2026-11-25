const busyMessage = "Finish or stop this agent’s open task before deleting it.";
function deletionError(error) {
  switch (error.code || error.message) {
    case "agents_agent_busy": return busyMessage;
    case "agents_deletion_unresolved": return "Review the unresolved work before deleting this agent.";
    case "agents_state_revision_conflict": return "The workspace changed. Open the confirmation again to review the current agent.";
    case "agents_deletion_pending":
    case "agents_deletion_cleanup_failed": return "Deletion is incomplete. Retry deletion to finish removing this agent.";
    default: return "Couldn’t confirm deletion. Check the connection and try again.";
  }
}

/** A confirmation is tied to one agent, environment and observed revision. */
export function createAgentDeletion({ client, view, drafts, isCurrent, onRemoved }) {
  let pending = null;
  const current = operation => pending === operation && isCurrent(operation.scope);
  function report(operation, message) {
    if (current(operation)) view.deletionStatus(message);
  }
  async function confirmAndDelete(operation) {
    const { id, scope } = operation;
    try {
      report(operation, "");
      const snapshot = await client.listAgents(scope.environment);
      if (!current(operation)) return false;
      const agent = snapshot.agents.find(entry => entry.id === id);
      if (!agent) return true;
      if (["active", "awaiting_user_decision"].includes(agent.mission?.status)) {
        report(operation, busyMessage);
        return false;
      }
      const count = agent.sessionCount;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid session count");
      const title = agent.isDeleting ? "Retry deletion?" : "Delete agent?";
      const confirmLabel = agent.isDeleting ? "Retry deletion" : "Delete permanently";
      const body = `Permanently delete ${agent.definition.name}, its private conversation, schedules, and ${count} work ${count === 1 ? "session" : "sessions"}? This cannot be undone.`;
      const confirmed = await view.confirmDeletion(body, { title, confirmLabel, tone: "danger" });
      if (!confirmed || !current(operation)) return false;
      report(operation, "Deleting…");
      await client.deleteAgent(id, { expectedRevision: snapshot.revision }, scope.environment);
      return true;
    } catch (error) {
      if ((error.code || error.message) === "agents_agent_not_found") return true;
      report(operation, deletionError(error));
      return false;
    }
  }
  async function remove(id, scope) {
    if (pending || !id || id === "abot") return;
    const operation = { id, scope };
    pending = operation;
    try {
      if (!await confirmAndDelete(operation)) return;
      let cleanupFailed = false;
      try { await drafts.removeAgent(scope.environment, id); } catch { cleanupFailed = true; }
      await onRemoved(id, scope, cleanupFailed);
    } finally {
      if (pending === operation) pending = null;
    }
  }
  return {
    remove, active: () => Boolean(pending),
    reset() { pending = null; view.cancelDeletionConfirmation?.(); },
  };
}
