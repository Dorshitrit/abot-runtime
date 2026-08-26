import { textOf } from "../lib/text-format.js";

export function createToolApprovalController({
  state,
  selectedEnvironmentId,
  sendRealtime,
  renderMessages,
  recordControlEvent,
  createCard: createApprovalCard,
}) {
  function isResolved(approvalId) {
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
    return [...state.events].reverse().find(isPending);
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
    state.submittedToolApprovalIds.add(approvalId);
    sendRealtime({
      type: "tool_approval_response",
      approvalId,
      approved,
      environment: selectedEnvironmentId(),
    });
    renderMessages();
    return true;
  }

  function createCard(event) {
    return createApprovalCard({
      event,
      submitted: state.submittedToolApprovalIds.has(textOf(event?.approvalId)),
      onDecision: submit,
    });
  }

  return { createCard, isPending, pendingEvent, submit };
}
