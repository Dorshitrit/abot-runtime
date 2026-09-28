import { hasLearningProcessingFailure, learningCollectionStatus, learningStateLabel, learningTimeLabel } from "./presentation.js";
import { isObservationReviewActive, observationReviewSummary } from "./processing-state.js";

const failures = new Set(["failed", "unavailable", "disconnected", "permission_required"]);

export function latestVisibleProposal(status) {
  return [...(status?.proactive?.proposals ?? [])].reverse().find((item) => item.status === "delivered");
}

function isReviewing(status) {
  if (isObservationReviewActive(status)) return true;
  if (status.reassessment?.state === "reviewing") return true;
  return status.proactive?.state === "reviewing";
}
function isCollecting(status) {
  status = learningCollectionStatus(status);
  if (!status.preferences?.enabled) return false;
  return status.state === "collecting" || status.state === "partial";
}
function hasActivityFailure(status) {
  if (hasLearningProcessingFailure(status)) return true;
  if (status.proactive?.state === "failed") return true;
  if (status.reassessment?.state === "failed" || status.maintenanceReason) return true;
  status = learningCollectionStatus(status);
  if (!failures.has(status.state)) return false;
  if (status.preferences?.enabled) return true;
  return status.state === "failed";
}
function isBudgetLimited(status) {
  if (status.proactive?.state === "budget_limited") return true;
  if (status.reassessment?.state === "budget_limited") return true;
  return String(status.reason || "").includes("budget_exhausted");
}
function isCompletelyPaused(status) {
  if (status.preferences?.enabled || status.preferences?.proactiveEnabled) return false;
  return status.preferences?.processingPaused || !status.preferences?.modelProfileId;
}

/** Presentation of committed runtime state only; this never advances a schedule. */
export function coWorkerAgentState(snapshot) {
  const status = snapshot.status;
  if (!status) return { mode: "quiet", label: "Connecting", title: "ABot Spark", description: "Checking the current activity…" };
  if (snapshot.statusError) return { mode: "attention", label: "Connection interrupted", title: "Waiting to reconnect.", description: "The last known activity is shown below. Refresh to check the connection." };
  if (isReviewing(status)) return { mode: "reviewing", label: "Working now", title: "Finding what matters.", description: status.proactive?.state === "reviewing" ? "Considering whether there’s something useful to offer you." : "Reviewing activity and refining what’s worth remembering." };
  if (latestVisibleProposal(status)) return { mode: "suggestion", label: "Something to share", title: "A thought for your next step.", description: "A conversation is ready. Read it when it suits you." };
  if (hasActivityFailure(status)) return { mode: "attention", label: "Needs attention",
    title: (status.processingReason || status.reason) === "learning_model_request_failed" ? "Let’s check the learning model." : "One activity needs attention.",
    description: hasLearningProcessingFailure(status) ? "Learning could not finish its review. Check learning settings; saved knowledge is still here." : "Your saved knowledge is still here. Check the activity details below." };
  if (isBudgetLimited(status)) return { mode: "quiet", label: "Taking a break", title: "Within your limits.", description: "The current budget is used up. Eligible work can continue after the limit resets." };
  if (isCollecting(status)) return { mode: "collecting", label: "Noticing activity", title: "Getting to know your rhythm.", description: "Collecting changes in your active apps. Only useful patterns should become lasting knowledge." };
  if (isCompletelyPaused(status)) return { mode: "quiet", label: "Taking a pause", title: "Ready when you are.", description: "Your saved knowledge is here. Each activity has its own controls." };
  return { mode: "waiting", label: "Ready in the background", title: "Room for the next idea.", description: "Waiting for eligible work. No model runs just to keep this screen alive." };
}

function nextLabel(value, window) {
  if (!value) return window ? `${window.start}–${window.end} · ${window.timeZone}` : "No hours restriction";
  return `Next ${learningTimeLabel(value)}${window ? ` · ${window.timeZone}` : ""}`;
}
export function coWorkerActivityStates(status) {
  if (!status) return { collection: ["—", ""], processing: ["—", ""], proactive: ["—", ""] };
  const p = status.preferences;
  const processing = processingLabel(status);
  const proactive = proactiveLabel(status);
  return {
    collection: [learningStateLabel(status), p.enabled ? nextLabel(status.nextCollectionAt, p.collectionWindow) : "No new activity collected"],
    processing: [processing, processingDetail(status)],
    proactive: [proactive, p.proactiveEnabled ? nextLabel(status.proactive?.nextReviewAt, p.proactiveWindow) : "No unsolicited messages"],
  };
}
function processingDetail(status) {
  if (isObservationReviewActive(status)) return observationReviewSummary(status);
  if (status.preferences.processingPaused) return "Pending activity stays within its retention limit";
  if (status.reviewPassRemaining > 0) {
    const remaining = `${status.reviewPassRemaining} observations left in this review`;
    if (status.nextAnalysisAt) return `${remaining} · ${nextLabel(status.nextAnalysisAt, status.preferences.analysisWindow)}`;
    return remaining;
  }
  if (status.preferences.analysisTrigger === "observations") {
    const progress = `${status.pendingObservations} / ${status.preferences.analysisObservationCount ?? 100} eligible observations`;
    if (status.nextAnalysisAt) return `${progress} · ${nextLabel(status.nextAnalysisAt, status.preferences.analysisWindow)}`;
    return progress;
  }
  return nextLabel(status.nextAnalysisAt || status.reassessment?.nextReviewAt, status.preferences.analysisWindow);
}

export function learningCadenceLabel(preferences) {
  if (preferences.analysisTrigger === "observations") return `Review at ${preferences.analysisObservationCount ?? 100} observations`;
  return `Every ${preferences.analysisIntervalMinutes ?? 15} min`;
}
function processingLabel(status) {
  if (isObservationReviewActive(status)) return "Processing now";
  if (!status.preferences.modelProfileId) return "Choose a model";
  if (status.preferences.processingPaused) return "Paused";
  if (status.reassessment?.state === "reviewing") return "Reviewing knowledge";
  if (hasLearningProcessingFailure(status)) return "Needs attention";
  if (status.reassessment?.state === "failed") return "Needs attention";
  if (status.reassessment?.state === "budget_limited") return "Budget reached";
  if (status.pendingObservations > 0) return `${status.pendingObservations} observations waiting`;
  return "Waiting for useful activity";
}
function proactiveLabel(status) {
  if (!status.preferences.proactiveEnabled) return "Off";
  if (status.proactive?.state === "reviewing") return "Considering an idea";
  if (status.proactive?.state === "budget_limited") return "Budget reached";
  if (status.proactive?.state === "failed") return "Needs attention";
  return "Enabled · waiting";
}

export function coWorkerActivityTones(status) {
  if (!status) return { collection: "off", processing: "off", proactive: "off" };
  const p = status.preferences;
  let collection = "off", processing = "off", proactive = "off";
  if (p.enabled) {
    collection = "waiting";
    if (isCollecting(status)) collection = "active";
    if (failures.has(learningCollectionStatus(status).state)) collection = "attention";
  }
  if (!p.processingPaused && p.modelProfileId) {
    processing = "ready";
    if (status.pendingObservations > 0) processing = "waiting";
    if (status.reassessment?.state === "reviewing") processing = "active";
    if (hasLearningProcessingFailure(status) || status.reassessment?.state === "failed" || status.reassessment?.state === "budget_limited") processing = "attention";
  }
  if (isObservationReviewActive(status)) processing = "active";
  if (p.proactiveEnabled) {
    proactive = "ready";
    if (status.proactive?.state === "reviewing") proactive = "active";
    if (status.proactive?.state === "failed" || status.proactive?.state === "budget_limited") proactive = "attention";
  }
  return { collection, processing, proactive };
}
