export function runtimeMaintenanceConfirmation(action, environmentId) {
  if (action === "sessions") return {
    title: "Delete sessions — including SPARK",
    confirmLabel: "Delete sessions and uploaded files",
    tone: "danger",
    message: `Permanently delete all conversations in "${environmentId}" and every file uploaded to those conversations. SPARK chat history and its uploaded files ARE INCLUDED. Schedules attached to deleted conversations are also removed. Standalone automations, long-term memory and learning settings are kept. SPARK can receive new messages afterward. This cannot be undone.`,
  };
  return {
    title: "Delete runtime logs",
    confirmLabel: "Delete logs",
    tone: "danger",
    message: `Permanently delete the current runtime log and all its rotated archives in "${environmentId}". Shared service logs and conversations are kept. New log entries will continue to be recorded. This cannot be undone.`,
  };
}

export function runtimeMaintenanceOutcome(action, result) {
  if (action === "logs") return `Runtime logs cleared (${result.clearedFiles} files). New events will be recorded normally.`;
  const deleted = result.deletedSessionIds.length;
  const spark = result.clearedSessionIds.length;
  if (!result.complete) return `Reset incomplete: ${deleted} conversations deleted, ${spark} SPARK histories cleared, ${result.failedSessionIds.length} sessions still need cleanup. Uploaded files are removed with their sessions. Review the remaining sessions before trying again.`;
  return `${deleted} conversations deleted. SPARK history cleared: ${spark}. Uploaded files were removed. New SPARK messages may arrive afterward.`;
}

export function runtimeMaintenanceError(error) {
  if (error?.code === "runtime_maintenance_busy") return "The runtime is busy. Finish or stop active work before resetting.";
  if (error?.code === "runtime_maintenance_pending_approvals") return "Resolve pending approvals before deleting conversations.";
  return error instanceof Error ? error.message : "The reset could not be completed.";
}
