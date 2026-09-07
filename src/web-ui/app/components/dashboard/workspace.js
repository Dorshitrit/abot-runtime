import { getDashboardJobTemplates } from "../../lib/dashboard-job-templates.js";
import { dashboardIcon } from "./icons.js";
import { renderDashboardActivity } from "./activity.js";
import { renderDashboardConversations } from "./recent-conversations.js";

const shortcuts = [
  {
    action: "attach",
    icon: "upload",
    title: "Upload a file",
    detail: "Image or document",
  },
  {
    action: "create-job",
    icon: "job",
    title: "Create a job",
    detail: "Schedule an agent task",
  },
  {
    action: "conversations",
    icon: "conversations",
    title: "Continue a chat",
    detail: "Pick up where you left off",
  },
  {
    action: "configuration",
    icon: "configuration",
    title: "Configuration",
    detail: "Models and tools",
  },
];

function shortcutMarkup(shortcut) {
  return `<button type="button" class="home-shortcut" data-dashboard-action="${shortcut.action}">${dashboardIcon(shortcut.icon)}<span><strong>${shortcut.title}</strong><small>${shortcut.detail}</small></span></button>`;
}

export function createDashboardWorkspace({ root, actions }) {
  root.classList.add("home-workspace");
  root.innerHTML = `<div class="home-workspace-body">
    <div class="home-overview">
      <section class="home-panel home-activity-panel" aria-label="Recent activity" data-dashboard-activity></section>
      <section class="home-panel home-recent-panel" aria-label="Recent conversations" data-dashboard-conversations></section>
    </div>
    <section class="home-workspace-start" aria-label="Start a new conversation">
      <div class="home-shortcuts" aria-label="Quick actions">${shortcuts.map(shortcutMarkup).join("")}</div>
      <div class="home-setup-host" data-dashboard-setup hidden></div>
      <div class="home-composer-host" data-dashboard-composer></div>
      <p class="home-composer-note">Starts a new conversation</p>
    </section>
  </div>`;
  const activity = root.querySelector("[data-dashboard-activity]");
  const conversations = root.querySelector("[data-dashboard-conversations]");
  const composerHost = root.querySelector("[data-dashboard-composer]");
  const setupHost = root.querySelector("[data-dashboard-setup]");
  const composerNote = root.querySelector(".home-composer-note");
  const handlers = {
    attach: () => actions.attach(),
    "create-job": () => actions.createJob(),
    template: (button) => actions.createJob(button.dataset.templateId),
    conversations: () => actions.continueConversation(),
    configuration: () => actions.openConfiguration(),
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
    activity.innerHTML = renderDashboardActivity({
      runs: snapshot.runs,
      loading: snapshot.loadingActivity,
      error: snapshot.activityError,
      supported: snapshot.supportsSchedules,
      templates: getDashboardJobTemplates(),
    });
    conversations.innerHTML = renderDashboardConversations({
      sessions: snapshot.sessions,
      loading: snapshot.loadingSessions,
      error: snapshot.sessionsError,
    });
    activity.setAttribute(
      "aria-busy",
      String(Boolean(snapshot.loadingActivity)),
    );
    conversations.setAttribute(
      "aria-busy",
      String(Boolean(snapshot.loadingSessions)),
    );
    root.querySelector('[data-dashboard-action="attach"]').disabled =
      snapshot.composerAvailable === false;
    root.querySelector('[data-dashboard-action="create-job"]').disabled =
      snapshot.supportsSchedules === false;
    composerHost.hidden = snapshot.composerAvailable === false;
    setupHost.hidden = snapshot.composerAvailable !== false;
    composerNote.hidden = snapshot.composerAvailable === false;
  }

  return { render, composerHost, setupHost };
}
