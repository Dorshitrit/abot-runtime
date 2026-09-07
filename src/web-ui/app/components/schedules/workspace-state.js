import { escapeHtml } from "../../lib/text-format.js";
import { scheduleErrorMessage } from "../../lib/schedule-errors.js";

export function scheduleWorkspaceState(snapshot) {
  if (snapshot.editor || snapshot.jobs.length) return null;
  if (snapshot.loading)
    return {
      kind: "loading",
      title: "Loading schedules",
      description: "Getting your tasks and conversations…",
    };
  if (snapshot.error)
    return {
      kind: "error",
      title: "Schedules are unavailable",
      description: scheduleErrorMessage(snapshot.error),
      action: "refresh",
      actionLabel: "Refresh schedules",
    };
  if (snapshot.selectedId)
    return {
      kind: "missing",
      title: "Schedule no longer available",
      description:
        "It may have been removed with its conversation. Retained conversation messages keep their original invocation details.",
      action: "refresh",
      actionLabel: "Refresh schedules",
    };
  if (!snapshot.sessions.length)
    return {
      kind: "empty",
      title: "Start with a conversation",
      description:
        "Every schedule belongs to a conversation. Start one, then choose what ABot should do and when it should return.",
      action: "chat",
      actionLabel: "Go to chat",
    };
  return {
    kind: "empty",
    title: "Your next task, right on time",
    description:
      "Create a schedule for a reminder, a recurring check or a task. ABot will run it and reply in its conversation.",
    action: "create",
    actionLabel: "Create your first schedule",
  };
}

export function renderScheduleWorkspaceState({ root, state, actions }) {
  root.hidden = !state;
  if (!state) return;
  root.dataset.state = state.kind;
  root.setAttribute("role", state.kind === "error" ? "alert" : "status");
  root.innerHTML = `<div class="schedule-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8.5"/><path d="M12 6.5V12l3.5 2"/></svg></div>
    <div class="schedule-state-copy"><h3>${escapeHtml(state.title)}</h3><p>${escapeHtml(state.description)}</p>
    ${state.action ? `<button type="button" class="${state.action === "create" ? "primary-button" : ""}" data-state-action>${escapeHtml(state.actionLabel)}</button>` : ""}</div>`;
  root
    .querySelector("[data-state-action]")
    ?.addEventListener("click", () => actions[state.action]());
}
