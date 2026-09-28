import { projectToolActivityEvent } from "./tool-activity-event.js";

/** Older saved decisions carry approvalId but omit the execution identity. */
export function correlateToolApprovalActivity(events, requestId) {
  const approvals = new Map();
  for (const event of events) {
    if (event?.requestId !== requestId || !event.approvalId) continue;
    const evidence = event.toolActivity || projectToolActivityEvent(event);
    if (evidence?.name !== "tool.approval.required") continue;
    if (evidence.executionId) approvals.set(event.approvalId, evidence);
  }
  return events.map((event) => {
    if (event?.requestId !== requestId) return event;
    const required = approvals.get(event.approvalId);
    if (!required) return event;
    const evidence =
      event.toolActivity ||
      projectToolActivityEvent({
        ...event,
        tool: event.tool || required.tool,
      });
    if (!evidence?.name.startsWith("tool.approval.")) return event;
    return {
      ...event,
      toolActivity: {
        ...evidence,
        executionId: evidence.executionId || required.executionId,
        executorRole: evidence.executorRole || required.executorRole,
        roleCallId: evidence.roleCallId || required.roleCallId,
      },
    };
  });
}
