import { recordCommandEvent, commandRunSummary } from "../lib/command-runs.js";

export function createCommandEventController({
  state,
  selectedEnvironmentId,
  recordControlEvent,
  trackSeq,
  settleTerminal,
  renderActivityStatus,
  updateComposerSendState,
  setMessageActivityStatus,
}) {
  return {
    handle(message) {
      if (message.requestKind !== "command") return false;
      const environment = selectedEnvironmentId();
      const record = recordCommandEvent(state, message, environment);
      if (!record) return true;
      if (message.sessionId !== state.currentSessionId) return true;
      if (
        (message.environment || message.environmentId || environment) !==
        environment
      )
        return true;
      const summary = commandRunSummary(record);
      const key = `command|${environment}|${message.sessionId}|${message.requestId}|${record.status}`;
      if (!state.events.some((event) => event.key === key))
        recordControlEvent({
          key,
          name: message.name,
          tone: record.terminal ? record.status : "active",
          summary,
        });
      trackSeq(message);
      if (!record.terminal && !state.activeRequestId)
        state.activeRequestId = message.requestId;
      if (record.terminal) settleTerminal(message, message.requestId);
      setMessageActivityStatus(summary, !record.terminal);
      updateComposerSendState();
      renderActivityStatus();
      return true;
    },
  };
}
