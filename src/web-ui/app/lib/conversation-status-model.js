import { buildConversationToolActions } from "./tool-activity-model.js";
import { isEventAfterContextWindowSnapshot } from "./context-window-snapshot-order.js";
import { textOf } from "./text-format.js";

const MODEL_STEP_LABELS = Object.freeze({
  "supervisor.decision": "Making a decision",
  "execution.decision": "Making a decision",
  "worker.decision": "Making a decision",
  "capability.controls": "Making a decision",
  "planner.decision": "Planning",
  "planner.graph": "Planning",
  "reviewer.decision": "Reviewing",
  "auditor.decision": "Reviewing",
  "worker.result": "Summarizing results",
  "supervisor.response": "Preparing response",
  "execution.response": "Preparing response",
  "degraded.finalization": "Preparing response",
  "context.compact": "Compacting context",
  "tool_payload.raw": "Working",
});

const SETTLED_TOOL_EVENTS = new Set([
  "tool.completed",
  "tool.failed",
  "tool.payload.failed",
  "tool.approval.rejected",
]);

function hasToolStatus(actions, status) {
  return actions.some((action) => action.status === status);
}

function hasMatchingContextRequest(contextWindow, requestId) {
  return textOf(contextWindow?.requestId) === requestId;
}

function hasPendingRequestCompaction(contextWindow, requestId) {
  if (!hasMatchingContextRequest(contextWindow, requestId)) return false;
  return Boolean(contextWindow.pendingCompaction);
}

function hasAcceptedRequestSnapshot(contextWindow, requestId) {
  if (!hasMatchingContextRequest(contextWindow, requestId)) return false;
  const snapshot = contextWindow.snapshot;
  if (!snapshot) return false;
  if (textOf(snapshot.requestId) !== requestId) return false;
  return snapshot.admissionOutcome === "accepted";
}

function isSettledToolAfterSnapshot(event, snapshot) {
  const name = textOf(
    event.toolActivity?.name ||
      event.eventName ||
      event.name ||
      event.rawType ||
      event.type,
  );
  if (!SETTLED_TOOL_EVENTS.has(name)) return false;
  return isEventAfterContextWindowSnapshot(snapshot, event);
}

function hasUsageForCurrentInvocation(contextWindow) {
  const invocationId = textOf(contextWindow.snapshot?.invocationId);
  if (!invocationId) return false;
  return textOf(contextWindow.providerUsage?.invocationId) === invocationId;
}

function activeStatus(label) {
  return { label, animate: true };
}

function modelStepLabel(modelStep) {
  if (!Object.hasOwn(MODEL_STEP_LABELS, modelStep)) return "Working";
  return MODEL_STEP_LABELS[modelStep];
}

export function buildConversationStatus({
  requestId,
  streaming = false,
  connected = true,
  contextWindow = null,
  events = [],
} = {}) {
  const activeRequestId = textOf(requestId).trim();
  if (!activeRequestId) return null;
  if (!streaming) return null;
  if (!connected) return { label: "Reconnecting", animate: false };

  const scopedEvents = events.filter(
    (event) => event.requestId === activeRequestId,
  );
  const tools = buildConversationToolActions({
    requestId: activeRequestId,
    streaming: true,
    events: scopedEvents,
  });
  if (hasToolStatus(tools, "awaiting_approval")) {
    return { label: "Waiting for approval", animate: false };
  }
  if (hasToolStatus(tools, "running")) return activeStatus("Running tool");
  if (hasPendingRequestCompaction(contextWindow, activeRequestId)) {
    return activeStatus("Compacting context");
  }
  if (hasToolStatus(tools, "preparing")) return activeStatus("Working");
  if (!hasAcceptedRequestSnapshot(contextWindow, activeRequestId)) {
    return activeStatus("Working");
  }
  const snapshot = contextWindow.snapshot;
  const settledAfterSnapshot = scopedEvents.some((event) =>
    isSettledToolAfterSnapshot(event, snapshot),
  );
  if (settledAfterSnapshot) return activeStatus("Working");
  if (hasUsageForCurrentInvocation(contextWindow))
    return activeStatus("Working");
  return activeStatus(modelStepLabel(snapshot.modelStep));
}
