import { escapeHtml } from "../../lib/text-format.js";
import { scheduleTimeLabel } from "../../lib/schedule-message.js";
import {
  emptyScheduleListMessage,
  matchesScheduleFilter,
  scheduleDescription,
} from "../../lib/schedule-presentation.js";
import { createScheduleForm } from "./form.js";
import { renderScheduleDetails } from "./details.js";
import { scheduleErrorMessage } from "../../lib/schedule-errors.js";
import {
  scheduleWorkspaceState,
  renderScheduleWorkspaceState,
} from "./workspace-state.js";

export function createSchedulesWorkspace({
  root,
  actions,
  getCurrentSessionId,
  getAgentModes,
  documentRoot = document,
  confirmDiscard = (message) => window.confirm(message),
}) {
  let editorIdentity = null;
  root.innerHTML = `<div class="schedules-toolbar"><label class="schedule-search"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input type="search" placeholder="Search schedules…" aria-label="Search schedules"></label>
    <select aria-label="Filter schedule status"><option value="current">Active &amp; paused</option><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="all">All statuses</option></select>
    <button type="button" data-refresh>Refresh</button><button type="button" class="primary-button" data-create>New schedule</button></div>
    <p class="schedules-feedback" role="status" aria-live="polite"></p>
    <section class="schedule-workspace-state" aria-live="polite" hidden></section>
    <div class="schedules-layout"><div class="schedules-list" aria-label="Schedules"></div><section class="schedule-details" aria-label="Schedule details"></section></div>`;
  const list = root.querySelector(".schedules-list");
  const details = root.querySelector(".schedule-details");
  const search = root.querySelector('[type="search"]');
  const filter = root.querySelector("select");
  const feedback = root.querySelector(".schedules-feedback");
  const createButton = root.querySelector("[data-create]");
  const toolbar = root.querySelector(".schedules-toolbar");
  const layout = root.querySelector(".schedules-layout");
  const workspaceState = root.querySelector(".schedule-workspace-state");
  search.addEventListener("input", applyFilter);
  filter.addEventListener("change", applyFilter);
  root.querySelector("[data-refresh]").addEventListener("click", () => {
    if (prepareLeave()) void actions.load();
  });
  createButton.addEventListener("click", () => {
    if (prepareLeave()) actions.beginEdit();
  });

  function prepareLeave() {
    if (!actions.snapshot().editor) return true;
    if (!canDiscardScheduleDraft()) return false;
    actions.cancelEdit();
    return true;
  }

  function canDiscardScheduleDraft() {
    const form = details.querySelector(".schedule-editor");
    if (form?.dataset.dirty !== "true") return true;
    return confirmDiscard("Discard this unsaved schedule?");
  }

  function applyFilter() {
    const query = search.value;
    const status = filter.value;
    if (!prepareLeave()) {
      const snapshot = actions.snapshot();
      search.value = snapshot.query;
      filter.value = snapshot.filter;
      return;
    }
    void actions.filter(query, status);
  }

  function render(snapshot) {
    search.value = snapshot.query;
    filter.value = snapshot.filter;
    const visible = snapshot.jobs.filter((job) =>
      matchesScheduleFilter(
        job,
        snapshot.query,
        snapshot.filter,
        snapshot.sessions,
      ),
    );
    const pageState = scheduleWorkspaceState(snapshot);
    const firstScheduleEditor =
      Boolean(snapshot.editor) && snapshot.jobs.length === 0;
    toolbar.hidden = Boolean(pageState) || firstScheduleEditor;
    layout.hidden = Boolean(pageState);
    feedback.hidden = Boolean(pageState) || firstScheduleEditor;
    renderScheduleWorkspaceState({
      root: workspaceState,
      state: pageState,
      actions: {
        refresh: () => void actions.load(),
        create: () => actions.beginEdit(),
        chat: () => actions.openConversation(getCurrentSessionId()),
      },
    });
    feedback.textContent =
      (snapshot.error ? scheduleErrorMessage(snapshot.error) : "") ||
      (snapshot.loading
        ? "Loading schedules…"
        : `${visible.length} shown · ${snapshot.jobs.length} schedules`);
    feedback.classList.toggle("schedule-error", Boolean(snapshot.error));
    root.setAttribute("aria-busy", String(snapshot.loading));
    createButton.disabled = snapshot.loading || snapshot.sessions.length === 0;
    createButton.title = snapshot.sessions.length
      ? "Create a schedule"
      : "Start a conversation before creating a schedule";
    if (pageState) return;
    layout.classList.toggle("schedule-editor-only", snapshot.jobs.length === 0);
    list.hidden = snapshot.jobs.length === 0;
    list.innerHTML =
      visible
        .map(
          (
            job,
          ) => `<button type="button" class="schedule-list-item${job.id === snapshot.selectedId ? " selected" : ""}" data-job-id="${escapeHtml(job.id)}" aria-pressed="${job.id === snapshot.selectedId}">
      <span class="schedule-list-top"><strong dir="auto" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</strong><span class="schedule-badge" data-state="${job.state}">${job.state}</span></span>
      <span class="schedule-list-meta"><span class="schedule-list-description" title="${escapeHtml(scheduleDescription(job))}">${escapeHtml(scheduleDescription(job))}</span>${job.nextRunAt ? `<span class="schedule-next-run" title="Next run · ${scheduleTimeLabel(job.nextRunAt, job.timeZone)}">${scheduleTimeLabel(job.nextRunAt, job.timeZone)}</span>` : ""}</span></button>`,
        )
        .join("") ||
      `<div class="schedule-list-empty">${escapeHtml(emptyScheduleListMessage(snapshot))}</div>`;
    for (const button of list.querySelectorAll("[data-job-id]")) {
      button.addEventListener("click", () => {
        if (button.dataset.jobId === actions.snapshot().selectedId) return;
        if (prepareLeave()) void actions.select(button.dataset.jobId);
      });
    }
    if (snapshot.editor) {
      details.classList.remove("schedule-details-placeholder");
      if (editorIdentity === snapshot.editor) return;
      editorIdentity = snapshot.editor;
      details.replaceChildren(
        createScheduleForm({
          documentRoot,
          job: snapshot.editor.job,
          initialValues: snapshot.editor.initialValues,
          sessions: snapshot.sessions,
          models: snapshot.models,
          modes: getAgentModes(),
          currentSessionId: getCurrentSessionId(),
          onSave: actions.save,
          onCancel: actions.cancelEdit,
        }),
      );
      details.querySelector('[name="title"]').focus();
      return;
    }
    editorIdentity = null;
    const openDetails = new Set(
      [...details.querySelectorAll("details[data-disclosure-id]")]
        .filter((node) => node.open)
        .map((node) => node.dataset.disclosureId),
    );
    renderScheduleDetails({ root: details, snapshot, actions });
    for (const node of details.querySelectorAll(
      "details[data-disclosure-id]",
    )) {
      node.open = openDetails.has(node.dataset.disclosureId);
    }
  }
  return { render, prepareLeave };
}
