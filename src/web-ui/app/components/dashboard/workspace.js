import { updateLiveRegion } from "../../lib/live-region.js";
import { getDashboardJobTemplates } from "../../lib/dashboard-job-templates.js";
import { renderDashboardActivity } from "./activity.js";
import { renderDashboardConversations } from "./recent-conversations.js";
import {
  hasPendingDashboardApprovals,
  renderDashboardApprovals,
} from "./approvals.js";

export function createDashboardWorkspace({ root, actions, passiveLearning }) {
  root.classList.add("home-workspace");
  root.innerHTML = `<div class="home-workspace-body">
    <div class="home-workspace-content">
      <section class="home-panel home-learning-panel" data-dashboard-learning hidden><div data-dashboard-learning-content></div></section>
      <div class="home-overview">
        <section class="home-panel home-activity-panel" aria-label="Recent activity" data-dashboard-activity></section>
        <section class="home-panel home-recent-panel" aria-label="Recent conversations" data-dashboard-conversations></section>
      </div>
      <div class="home-setup-host" data-dashboard-setup hidden></div>
      <section class="home-panel home-approvals-panel" aria-label="Pending approvals" data-dashboard-approvals hidden></section>
    </div>
    <div class="home-approval-dock" data-dashboard-approval-dock hidden></div>
    <section class="home-workspace-start" aria-label="Start a new conversation">
      <div class="home-composer-host" data-dashboard-composer></div>
      <p class="home-composer-note">Starts a new conversation</p>
    </section>
  </div>`;
  const overview = root.querySelector(".home-overview");
  const activity = root.querySelector("[data-dashboard-activity]");
  const conversations = root.querySelector("[data-dashboard-conversations]");
  const approvals = root.querySelector("[data-dashboard-approvals]");
  const approvalDock = root.querySelector("[data-dashboard-approval-dock]");
  const content = root.querySelector(".home-workspace-content");
  const composerHost = root.querySelector("[data-dashboard-composer]");
  const setupHost = root.querySelector("[data-dashboard-setup]");
  const learningPanel = root.querySelector("[data-dashboard-learning]");
  passiveLearning?.mountHome(root.querySelector("[data-dashboard-learning-content]"));
  const composerNote = root.querySelector(".home-composer-note");
  const handlers = {
    template: (button) => actions.createJob(button.dataset.templateId),
    conversations: () => actions.continueConversation(),
    jobs: () => actions.openJobs(),
    conversation: (button) =>
      actions.openConversation(
        button.dataset.sessionId,
        button.dataset.requestId || undefined,
      ),
    refresh: () => actions.refresh(),
  };
  root.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-dashboard-action]");
    if (!button || !root.contains(button) || button.disabled) return;
    handlers[button.dataset.dashboardAction]?.(button);
  });

  function render(snapshot) {
    const setupRequired = snapshot.composerAvailable === false;
    const pendingApprovals = hasPendingDashboardApprovals(snapshot);
    approvalDock.hidden = setupRequired || !pendingApprovals;
    // Keep pending actions beside the composer; refresh errors stay in content.
    const approvalParent = pendingApprovals ? approvalDock : content;
    if (approvals.parentElement !== approvalParent)
      approvalParent.appendChild(approvals);
    root.classList.toggle("home-setup-active", setupRequired);
    learningPanel.hidden = setupRequired || !passiveLearning;
    overview.hidden = setupRequired;
    approvals.hidden = setupRequired;
    composerHost.hidden = snapshot.composerAvailable === false;
    setupHost.hidden = snapshot.composerAvailable !== false;
    composerNote.hidden = snapshot.composerAvailable === false;
    if (setupRequired) {
      activity.innerHTML = "";
      conversations.innerHTML = "";
      approvals.innerHTML = "";
      return;
    }

    renderDashboardApprovals({
      root: approvals,
      snapshot,
      onDecision: actions.decideApproval,
      documentRoot: root.ownerDocument,
    });

    updateLiveRegion(
      activity,
      renderDashboardActivity({
        runs: snapshot.runs,
        loading: snapshot.loadingActivity,
        error: snapshot.activityError,
        supported: snapshot.supportsSchedules,
        templates: getDashboardJobTemplates(),
      }),
    );
    updateLiveRegion(
      conversations,
      renderDashboardConversations({
        sessions: snapshot.sessions,
        loading: snapshot.loadingSessions,
        error: snapshot.sessionsError,
      }),
    );
    activity.setAttribute(
      "aria-busy",
      String(Boolean(snapshot.loadingActivity)),
    );
    conversations.setAttribute(
      "aria-busy",
      String(Boolean(snapshot.loadingSessions)),
    );
  }

  return { render, composerHost, setupHost };
}
