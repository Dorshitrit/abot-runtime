import { textOf } from "../lib/text-format.js";
import { requestLifecycles } from "../lib/request-lifecycle-view.js";
import { approvalDecisionCommand } from "../lib/approval-decision-command.js";
import { projectToolActivityEvent } from "../lib/tool-activity-event.js";

export function createToolApprovalController({
  state,
  selectedEnvironmentId,
  sendRealtime,
  renderMessages,
  recordControlEvent,
  createCard: createApprovalCard,
}) {
  function isResolved(approvalId) {
    for (const lifecycle of requestLifecycles(state).values()) {
      if (
        lifecycle.decisionReceipts.some(
          (receipt) => receipt.approvalId === approvalId,
        )
      )
        return true;
    }
    for (const message of state.messages ?? []) {
      const group = message.approvalRequest;
      if (group?.state === "pending") continue;
      if (
        group?.approvals.some((approval) => approval.approvalId === approvalId)
      )
        return true;
    }
    return state.events.some((event) => {
      const name = textOf(event.eventName || event.name);
      return (
        textOf(event.approvalId) === approvalId &&
        (name === "tool.approval.granted" || name === "tool.approval.rejected")
      );
    });
  }

  function isPending(event) {
    const approvalId = textOf(event?.approvalId);
    return (
      Boolean(approvalId) &&
      textOf(event?.eventName || event?.name) === "tool.approval.required" &&
      !isResolved(approvalId)
    );
  }

  function pendingEvent() {
    return pendingEvents().at(-1);
  }

  function pendingEvents() {
    const pending = new Map(
      state.events.filter(isPending).map((event) => [event.approvalId, event]),
    );
    for (const lifecycle of requestLifecycles(state).values()) {
      if (lifecycle.status !== "awaiting_approval" || !lifecycle.wait) continue;
      for (const approval of lifecycle.wait.approvals) {
        if (isResolved(approval.approvalId)) continue;
        const event = {
          ...approval.presentation,
          type: "event",
          name: "tool.approval.required",
          eventName: "tool.approval.required",
          sessionId: lifecycle.sessionId,
          requestId: lifecycle.requestId,
          approvalId: approval.approvalId,
          generation: lifecycle.generation,
          waitId: lifecycle.wait.waitId,
          revision: lifecycle.revision,
        };
        pending.set(approval.approvalId, {
          ...event,
          toolActivity: projectToolActivityEvent(event),
        });
      }
    }
    return [...pending.values()];
  }

  function submit(approvalId, approved) {
    if (!state.connected) {
      recordControlEvent({
        type: "control",
        name: "Approval failed",
        tone: "failed",
        summary: "Realtime connection is not available.",
      });
      return false;
    }
    const pending = pendingEvents().find(
      (event) => event.approvalId === approvalId,
    );
    if (!pending || state.submittedToolApprovalIds.has(approvalId))
      return false;
    state.submittedToolApprovalIds.add(approvalId);
    const sent = sendRealtime({
      type: "tool_approval_response",
      approvalId,
      approved,
      environment: selectedEnvironmentId(),
      ...(pending.waitId
        ? {
            sessionId: pending.sessionId,
            requestId: pending.requestId,
            ...approvalDecisionCommand(pending, approved),
          }
        : {}),
    });
    if (sent === false) state.submittedToolApprovalIds.delete(approvalId);
    renderMessages();
    return sent !== false;
  }

  function createCard(event) {
    return createApprovalCard({
      event,
      submitted: state.submittedToolApprovalIds.has(textOf(event?.approvalId)),
      onDecision: submit,
    });
  }

  return { createCard, isPending, pendingEvent, pendingEvents, submit };
}
