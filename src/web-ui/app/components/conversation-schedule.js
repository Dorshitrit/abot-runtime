import {
  normalizeScheduleReference,
  scheduleTimeLabel,
} from "../lib/schedule-message.js";

export function createConversationSchedule({
  documentRoot = document,
  onOpenJob = () => {},
  canOpenJob = () => true,
} = {}) {
  const expandedRuns = new Set();

  function createNode(message) {
    if (message.role !== "user") return null;
    const schedule = normalizeScheduleReference(message.schedule);
    if (!schedule) return null;
    const row = documentRoot.createElement("article");
    row.className = "message-row schedule-message-row";
    row.dataset.requestId = message.requestId || "";
    row.setAttribute("aria-label", "Scheduled task invocation");
    const card = documentRoot.createElement("div");
    card.className = "schedule-chat-card";
    card.dataset.jobId = schedule.jobId;
    card.dataset.runId = schedule.runId;
    const eyebrow = documentRoot.createElement("div");
    eyebrow.className = "schedule-eyebrow";
    eyebrow.textContent =
      schedule.triggerType === "manual"
        ? "Run now · Scheduled task"
        : "Scheduled task";
    const title = documentRoot.createElement("button");
    title.type = "button";
    title.className = "schedule-chat-title";
    title.dir = "auto";
    title.textContent = schedule.title;
    title.setAttribute("aria-label", `View schedule: ${schedule.title}`);
    title.disabled = !canOpenJob();
    if (title.disabled)
      title.title = "Schedules require the local Runtime backend.";
    title.addEventListener("click", () => {
      if (!canOpenJob()) return;
      onOpenJob(schedule.jobId, schedule.runId);
    });
    const time = documentRoot.createElement("div");
    time.className = "schedule-chat-time";
    time.textContent = scheduleTimeLabel(
      schedule.scheduledAt || message.createdAt,
    );
    const disclosure = documentRoot.createElement("details");
    disclosure.className = "schedule-prompt-disclosure";
    disclosure.open = expandedRuns.has(schedule.runId);
    disclosure.addEventListener("toggle", () => {
      if (disclosure.open) {
        expandedRuns.add(schedule.runId);
        return;
      }
      expandedRuns.delete(schedule.runId);
    });
    const summary = documentRoot.createElement("summary");
    summary.textContent = "View invocation prompt";
    const prompt = documentRoot.createElement("pre");
    prompt.dir = "auto";
    prompt.textContent = message.text || "";
    disclosure.append(summary, prompt);
    card.append(eyebrow, title, time, disclosure);
    row.appendChild(card);
    return row;
  }

  return { createNode, reset: () => expandedRuns.clear() };
}
