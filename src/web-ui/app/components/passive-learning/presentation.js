import { learningFailureCopy } from "./failure-copy.js";

const setupRequiredReasons = new Set([
  "host_not_paired",
  "host_observations_unsupported",
  "learning_host_unavailable",
]);

const connectReasons = new Set([
  ...setupRequiredReasons,
  "host_disconnected",
  "host_broker_unavailable",
  "host_observation_connect_timeout",
  "learning_device_changed",
  "macos_accessibility_permission_required",
  "macos_accessibility_permission_timeout",
  "macos_accessibility_permission_revoked",
]);

const failureStates = new Set([
  "failed", "unavailable", "disconnected", "permission_required",
]);

const collectionFailureReasons = new Set([
  ...connectReasons,
  "host_observations_already_owned",
  "host_observation_cancelled",
  "platform_unsupported",
  "macos_swift_tools_unavailable",
  "collector_output_limit",
  "collector_protocol_invalid",
  "collector_dependency_unavailable",
  "collector_start_failed",
]);

export function learningCollectionStatus(status) {
  if (!status || status.collectionState === undefined) return status;
  return { ...status, state: status.collectionState, reason: status.collectionReason };
}

export function hasLearningProcessingFailure(status) {
  if (status?.processingReason) return true;
  if (status?.collectionState !== undefined) return false;
  if (status?.state !== "failed") return false;
  return !collectionFailureReasons.has(status.reason);
}

const visibleAccessibilityReasons = new Set([
  "uia_application_coverage",
  "ax_application_coverage",
  "atspi_application_coverage",
  "wayland_atspi_coverage",
  "x11_atspi_coverage",
]);

export function learningFailurePresentation(status) {
  if (!status) return null;
  const processingFailure = hasLearningProcessingFailure(status);
  status = processingFailure ? { ...status, state: "failed", reason: status.processingReason || status.reason } : learningCollectionStatus(status);
  if (!failureStates.has(status.state)) return null;
  if (!status.preferences?.enabled && !processingFailure) return null;
  const connectComputer = connectReasons.has(status.reason);
  const explanation = learningFailureCopy(status.reason);
  const fallback = status.state === "permission_required"
    ? "Computer access needs permission before learning can collect activity."
    : "Learning cannot collect activity right now. See Activity for technical details.";
  const message = explanation.code || processingFailure ? explanation.message : fallback;
  return { message, connectComputer };
}

export function learningIntroText(status) {
  status = learningCollectionStatus(status);
  if (status?.preferences?.enabled && status.reason === "continuous_activity")
    return "Continuous screen changes are muted. Collection resumes after switching windows, editing, or 30 quiet seconds.";
  if (!status) return "Checking collection status…";
  if (!status.preferences?.enabled)
    return "No activity is being collected. Your saved insights are kept.";
  if (failureStates.has(status.state))
    return "Collection needs attention. Your saved insights are still available.";
  if (status.state === "paused")
    return "Collection is paused. Your saved insights are still available.";
  if (status.reason === "accessibility_read_unavailable")
    return "The current app is not providing readable content.";
  if (status.state === "partial" || status.state === "collecting")
    return "Learning from visible computer activity.";
  return "Connecting to your computer.";
}

export function learningProcessingLabel(status) {
  if (!status) return "";
  if (status.preferences?.processingPaused)
    return "Processing paused. Pending activity is kept until its retention limit.";
  if (status.processing || status.activeBatches > 0) return "Processing collected activity.";
  if (!status.preferences?.modelProfileId)
    return "Choose a model in Settings to process collected activity.";
  if (hasLearningProcessingFailure(status))
    return "Processing needs attention before pending activity can be reviewed.";
  if (status.pendingObservations > 0)
    return "Pending activity will be processed on the existing schedule.";
  return "Processing is ready when activity is available.";
}

export function learningRetentionText(status) {
  const hours = status?.retentionHours;
  if (typeof hours === "number" && Number.isFinite(hours) && hours > 0)
    return `Pending activity expires ${hours} hours after collection, including while processing is paused. Saved insights are kept.`;
  return "Pending activity is kept within the configured retention period, including while processing is paused. Saved insights are kept.";
}

export function hasVisibleLearningWork(status) {
  if (!status) return false;
  if (status.preferences?.enabled) return true;
  return hasUnprocessedLearningActivity(status);
}

export function hasUnprocessedLearningActivity(status) {
  if (!status) return false;
  if (status.blockedObservations > 0) return true;
  if (status.pendingObservations > 0) return true;
  if (status.activeBatches > 0) return true;
  return status.processing === true;
}

export function learningCoveragePresentation(status) {
  status = learningCollectionStatus(status);
  if (!status) return { label: "Checking access", detail: "" };
  if (!status.preferences?.enabled)
    return { label: "Not collecting", detail: "" };
  if (status.state === "partial" && status.reason === "accessibility_read_unavailable")
    return { label: "Some content unreadable", detail: "The active app did not expose readable content." };
  if (status.state === "partial" && visibleAccessibilityReasons.has(status.reason))
    return { label: "Visible app content", detail: "Some content is not exposed by apps." };
  if (status.state === "partial")
    return { label: "Limited app visibility", detail: "Some content may be unavailable." };
  if (status.state === "collecting")
    return { label: "App content available", detail: "Coverage varies by app." };
  if (status.state === "starting")
    return { label: "Checking access", detail: "" };
  return { label: "Not collecting", detail: "" };
}

export function learningStateLabel(status) {
  status = learningCollectionStatus(status);
  if (!status) return "Loading";
  if (!status.preferences?.enabled) return "Collection stopped";
  if (status.state === "partial" && status.reason === "accessibility_read_unavailable")
    return "Limited access";
  if (failureStates.has(status.state) && setupRequiredReasons.has(status.reason))
    return "Setup required";
  const labels = {
    starting: "Connecting",
    collecting: "Collecting",
    partial: "Collecting",
    unavailable: "Unavailable",
    permission_required: "Permission required",
    paused: "Paused",
    stopped: "Stopped",
    disconnected: "Disconnected",
    failed: "Failed",
    off: "Waiting to start",
  };
  return labels[status.state] || "Status unavailable";
}

export function learningTimeLabel(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "Not yet";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function learningModelLabel(profile) {
  const name = profile.label || profile.id;
  const provider = profile.providerId || profile.provider || "Provider unavailable";
  return `${name} · ${provider}`;
}

export function learningPreview(value, limit = 110) {
  const text = String(value || "").replaceAll(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}
