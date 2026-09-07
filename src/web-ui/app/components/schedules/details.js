import { escapeHtml } from "../../lib/text-format.js";
import { scheduleTimeLabel } from "../../lib/schedule-message.js";
import { scheduleErrorMessage } from "../../lib/schedule-errors.js";
import {
  canManageSchedule,
  canRunScheduleNow,
  scheduleDescription,
} from "../../lib/schedule-presentation.js";

function fact(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd dir="auto">${escapeHtml(value || "—")}</dd></div>`;
}

function actionsMarkup(job, busy) {
  const disabled = busy ? "disabled" : "";
  const action = (name, label) =>
    `<button type="button" data-job-action="${name}" ${disabled}>${label}</button>`;
  const controls = [];
  if (canManageSchedule(job)) controls.push(action("edit", "Edit"));
  if (canRunScheduleNow(job)) controls.push(action("run-now", "Run now"));
  if (job.state === "active") controls.push(action("pause", "Pause"));
  if (job.state === "paused") controls.push(action("resume", "Resume"));
  if (canManageSchedule(job))
    controls.push(action("cancel", "Cancel schedule"));
  return controls.join("");
}

function runMarkup(run) {
  const timeZone = run.timeZone;
  return `<article class="schedule-run" data-run-id="${escapeHtml(run.id)}">
    <div class="schedule-run-heading"><strong>${scheduleTimeLabel(run.scheduledAt, timeZone)}</strong><span class="schedule-badge" data-state="${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></div>
    <div class="schedule-run-meta">${run.trigger === "manual" ? "Manual run" : "Scheduled run"}${run.startedAt ? ` · Started ${scheduleTimeLabel(run.startedAt, timeZone)}` : ""}${run.finishedAt ? ` · Finished ${scheduleTimeLabel(run.finishedAt, timeZone)}` : ""}</div>
    <dl class="schedule-run-settings">${fact("Model", run.modelProfileId)}${fact("Mode", run.agentMode)}${fact("Time zone", run.timeZone)}${fact("Job revision", String(run.jobRevision ?? "—"))}</dl>
    ${run.error ? `<p class="schedule-error" dir="auto">${escapeHtml(run.error)}</p>` : ""}
    ${run.resultText ? `<details class="schedule-result" data-disclosure-id="result:${escapeHtml(run.id)}"><summary>View result</summary><pre dir="auto">${escapeHtml(run.resultText)}</pre></details>` : ""}
    <details class="schedule-prompt-disclosure" data-disclosure-id="run:${escapeHtml(run.id)}"><summary>View invocation prompt</summary><pre dir="auto">${escapeHtml(run.prompt)}</pre></details>
    ${run.requestId ? `<button type="button" class="schedule-text-button" data-open-request="${escapeHtml(run.requestId)}">Open in conversation ↗</button>` : ""}
    <small class="schedule-id">Run ${escapeHtml(run.id)}${run.requestId ? ` · Request ${escapeHtml(run.requestId)}` : ""}</small>
  </article>`;
}

function historyNavigation(snapshot) {
  const latest = snapshot.loadingRuns || !snapshot.runsCursor;
  const newer = snapshot.loadingRuns || !snapshot.runsPreviousCursors?.length;
  const older = snapshot.loadingRuns || !snapshot.runsNextCursor;
  const button = (name, label, disabled) =>
    `<button type="button" data-run-page="${name}" ${disabled ? "disabled" : ""}>${label}</button>`;
  return `<nav class="schedule-action-row" aria-label="Run history pages">
    ${button("latest", "Newest", latest)}${button("newer", "Newer", newer)}${button("older", "Older", older)}
  </nav>`;
}

export function renderScheduleDetails({ root, snapshot, actions }) {
  const job = snapshot.jobs.find((item) => item.id === snapshot.selectedId);
  if (!job) {
    root.classList.add("schedule-details-placeholder");
    root.innerHTML = `<div class="schedule-detail-empty"><span aria-hidden="true">◷</span><h3>${snapshot.selectedId ? "Schedule unavailable" : "Select a schedule"}</h3><p>${snapshot.selectedId ? "This schedule may have been removed with its conversation." : "See when it runs, manage its settings and follow its results here."}</p></div>`;
    return;
  }
  root.classList.remove("schedule-details-placeholder");
  const session = snapshot.sessions.find((item) => item.id === job.sessionId);
  root.innerHTML = `<div class="schedule-detail-heading"><span class="schedule-eyebrow">Scheduled task</span><h3 dir="auto">${escapeHtml(job.title)}</h3><span class="schedule-badge" data-state="${job.state}">${job.state}</span></div>
    <div class="schedule-action-row">${actionsMarkup(job, snapshot.mutation)}</div>
    <dl class="schedule-facts">${fact("Schedule", scheduleDescription(job))}${fact("Next run", scheduleTimeLabel(job.nextRunAt, job.timeZone))}${fact("Time zone", job.timeZone)}${fact("Model", job.modelProfileId)}${fact("Mode", job.agentMode)}${fact("Tool access", "Full")}${fact("Created", scheduleTimeLabel(job.createdAt, job.timeZone))}${fact("Updated", scheduleTimeLabel(job.updatedAt, job.timeZone))}</dl>
    <button type="button" class="schedule-conversation-link" data-open-conversation>↗ <span dir="auto">${escapeHtml(session?.title || job.sessionId)}</span></button>
    <details class="schedule-prompt-disclosure" data-disclosure-id="job:${escapeHtml(job.id)}"><summary>View task prompt</summary><pre dir="auto">${escapeHtml(job.prompt)}</pre></details>
    <small class="schedule-id">Job ${escapeHtml(job.id)} · Revision ${job.revision}</small>
    <section class="schedule-history"><div class="schedule-section-heading"><h3>Run history</h3><span>${snapshot.runs.length} runs on this page</span></div>
      ${historyNavigation(snapshot)}
      ${snapshot.loadingRuns ? '<p role="status">Loading runs…</p>' : ""}
      ${snapshot.detailError ? `<p role="alert" class="schedule-error">${escapeHtml(scheduleErrorMessage(snapshot.detailError))}</p>` : ""}
      ${snapshot.runs.map((run) => runMarkup(run)).join("") || (!snapshot.loadingRuns && !snapshot.detailError ? '<p class="schedule-muted">No recorded runs yet.</p>' : "")}</section>`;
  for (const button of root.querySelectorAll("[data-job-action]")) {
    button.addEventListener("click", () => {
      if (button.dataset.jobAction === "edit") {
        actions.beginEdit(job.id);
        return;
      }
      void actions.action(job.id, button.dataset.jobAction);
    });
  }
  root
    .querySelector("[data-open-conversation]")
    .addEventListener("click", () => actions.openConversation(job.sessionId));
  for (const button of root.querySelectorAll("[data-open-request]")) {
    button.addEventListener("click", () =>
      actions.openConversation(job.sessionId, button.dataset.openRequest),
    );
  }
  const runPageActions = {
    latest: actions.latestRuns,
    newer: actions.newerRuns,
    older: actions.olderRuns,
  };
  for (const button of root.querySelectorAll("[data-run-page]")) {
    button.addEventListener(
      "click",
      () => void runPageActions[button.dataset.runPage](),
    );
  }
}
