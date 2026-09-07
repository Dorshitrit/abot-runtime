import { projectToolActivityEvent } from "./tool-activity-event.js";

/** Tool lifecycle belongs to the action rows; other diagnostics retain their timeline. */
export function isNonToolTimelineEvent(event) {
  const evidence = event.toolActivity || projectToolActivityEvent(event);
  if (!evidence) return true;
  if (evidence.executionId) return false;
  return !isRecordedToolOutcome(evidence.name);
}

function isRecordedToolOutcome(name) {
  return (
    name === "tool.completed" ||
    name === "tool.failed" ||
    name === "tool.payload.failed" ||
    name === "tool.approval.rejected"
  );
}
