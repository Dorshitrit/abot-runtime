import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardWorkspace } from "../../web-ui/app/components/dashboard/workspace.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderDashboardAutomations } from "../../web-ui/app/components/dashboard/automations.js";
import { createHomeWidgetsHarness, type HomeWidgetElement } from "./support/home-widgets-harness.js";

function dashboardHarness(passiveLearning?: { mountHome: ReturnType<typeof vi.fn> }) {
  const harness = createHomeWidgetsHarness(1600, false);
  const root = harness.root;
  const actions = {
    createJob: vi.fn(), continueConversation: vi.fn(), openJobs: vi.fn(),
    openConversation: vi.fn(), refresh: vi.fn(),
  };
  const workspace = createDashboardWorkspace({ root, actions, passiveLearning });
  const node = (selector: string) => root.querySelector(selector) as HomeWidgetElement;
  const refs = {
    learning: node("[data-dashboard-learning]"),
    learningContent: node("[data-dashboard-learning-content]"),
    automations: node("[data-dashboard-automations]"),
    resources: node("[data-dashboard-resources]"),
    overview: node(".home-overview"),
    activity: node("[data-dashboard-activity]"),
    conversations: node("[data-dashboard-conversations]"),
    composer: node("[data-dashboard-composer]"),
    setup: node("[data-dashboard-setup]"),
    note: node(".home-composer-note"),
    approvals: node("[data-dashboard-approvals]"),
    content: node(".home-workspace-content"),
    dock: node("[data-dashboard-approval-dock]"),
  };
  return {
    workspace, root, refs, actions,
    click(dataset: Record<string, string>, disabled = false) {
      const button = harness.createElement("button");
      Object.assign(button.dataset, dataset);
      button.disabled = disabled;
      const panel = dataset.dashboardAction === "conversations" ? refs.conversations : refs.activity;
      panel.append(button);
      button.dispatch("click");
      button.remove();
    },
  };
}

const loaded = {
  sessions: [{ id: "session-one", title: "Conversation", unreadCount: 2 }],
  runs: [],
  loadingSessions: false,
  loadingActivity: false,
  sessionsError: "",
  activityError: "",
  supportsSchedules: true,
  composerAvailable: true,
};

describe("dashboard presentation interactions", () => {
  test("shows only active automation runs with a direct Studio link", () => {
    const markup = renderDashboardAutomations([{ id: "automation-one", title: "Daily brief",
      latestRunId: "run-one", latestRunStatus: "running" }], "dev");
    expect(markup).toContain("Daily brief");
    expect(markup).toContain("Running · View live timeline");
    expect(markup).toContain("/automations?environment=dev&amp;automation=automation-one&amp;run=run-one");
    expect(renderDashboardAutomations([{ id: "automation-one", title: "Daily brief",
      latestRunId: "run-one", latestRunStatus: "pending" }], "dev"))
      .toContain("Queued · View live timeline");
    const unavailable = renderDashboardAutomations([{ id: "automation-one", title: "Daily brief",
      latestRunId: "run-one", latestRunStatus: "running" }], "dev", true);
    expect(unavailable).toContain("Automation status unavailable");
    expect(unavailable).toContain("Last seen Running · Open run");
    expect(unavailable).toContain('data-dashboard-action="refresh"');
    const { workspace, refs } = dashboardHarness();
    workspace.render({ ...loaded, environmentId: "dev", activeAutomations: [{
      id: "automation-one", title: "Daily brief", latestRunId: "run-one",
      latestRunStatus: "running",
    }] });
    expect(refs.automations.hidden).toBe(false);
    expect(refs.automations.innerHTML).toContain("Daily brief");
    workspace.render(loaded);
    expect(refs.automations.hidden).toBe(true);
  });

  test("keeps pending approvals beside the composer and removes the dock when they resolve", () => {
    const { workspace, refs } = dashboardHarness();
    refs.composer.innerHTML = "<form>Unsent draft</form>";
    const pending = {
      ...loaded,
      approvals: [
        {
          environmentId: "dev",
          sessionId: "session-one",
          requestId: "request-one",
          approvalId: "approval-one",
          event: {
            name: "tool.approval.required",
            tool: "system_command",
            approvalId: "approval-one",
            meta: { command: "echo hello" },
          },
        },
      ],
    };
    workspace.render(pending);
    expect(refs.dock.hidden).toBe(false);
    expect(refs.approvals.parentElement).toBe(refs.dock);
    expect(refs.approvals.textContent).toContain("Approve");
    const approval = refs.approvals.querySelector(".home-approval");
    workspace.render({
      ...pending,
      runs: [{ id: "new", title: "New activity", status: "succeeded" }],
    });
    expect(refs.approvals.querySelector(".home-approval")).toBe(approval);
    expect(refs.composer.innerHTML).toBe("<form>Unsent draft</form>");
    workspace.render(loaded);
    expect(refs.dock.hidden).toBe(true);
    expect(refs.approvals.hidden).toBe(true);
    workspace.render({ ...loaded, approvalsError: "Offline" });
    expect(refs.dock.hidden).toBe(true);
    expect(refs.approvals.parentElement).toBe(refs.content);
    expect(refs.approvals.textContent).toContain("Offline");
    workspace.render({ ...pending, composerAvailable: false });
    expect(refs.dock.hidden).toBe(true);
  });

  test("keeps the shared composer host and contents intact through card updates", () => {
    const { workspace, refs } = dashboardHarness();
    refs.composer.innerHTML = "<form data-existing-composer>Draft</form>";
    const composer = refs.composer.querySelector("[data-existing-composer]");
    const markup = refs.composer.innerHTML;
    workspace.render(loaded);
    workspace.render({
      ...loaded,
      sessions: [{ ...loaded.sessions[0], unreadCount: 0 }],
      runs: [{ id: "run-one", title: "Done", status: "succeeded" }],
    });
    expect(workspace.composerHost).toBe(refs.composer);
    expect(refs.composer.innerHTML).toBe(markup);
    expect(refs.composer.querySelector("[data-existing-composer]")).toBe(composer);
    expect(refs.conversations.innerHTML).toContain(
      'data-session-id="session-one"',
    );
    expect(refs.conversations.innerHTML).not.toContain("has-unread");
  });

  test("dispatches each click once with exact template or request identity", () => {
    const { workspace, click, actions } = dashboardHarness();
    workspace.render(loaded);
    workspace.render(loaded);
    click({ dashboardAction: "template", templateId: "learning" });
    expect(actions.createJob).toHaveBeenCalledExactlyOnceWith("learning");
    click({
      dashboardAction: "conversation",
      sessionId: "session-one",
      requestId: "request-one",
    });
    expect(actions.openConversation).toHaveBeenCalledExactlyOnceWith(
      "session-one",
      "request-one",
    );
    expect(actions.openJobs).not.toHaveBeenCalled();
    expect(actions.continueConversation).not.toHaveBeenCalled();
  });

  test("keeps header navigation without duplicated quick actions", () => {
    const { root, click, actions } = dashboardHarness();
    expect(root.innerHTML).not.toContain("home-shortcuts");
    expect(root.innerHTML).not.toContain('data-dashboard-action="attach"');
    expect(root.innerHTML).not.toContain('data-dashboard-action="create-job"');
    expect(root.innerHTML).not.toContain('data-dashboard-action="configuration"');
    click({ dashboardAction: "jobs" }, true);
    expect(actions.openJobs).not.toHaveBeenCalled();
    click({ dashboardAction: "conversations" });
    click({ dashboardAction: "jobs" });
    click({ dashboardAction: "refresh" });
    expect(actions.continueConversation).toHaveBeenCalledOnce();
    expect(actions.openJobs).toHaveBeenCalledOnce();
    expect(actions.refresh).toHaveBeenCalledOnce();
    expect(actions.createJob).not.toHaveBeenCalled();
    expect(actions.openConversation).not.toHaveBeenCalled();
  });

  test("onboarding hides Spark even when its asynchronous view unhides its own mount", () => {
    const passiveLearning = { mountHome: vi.fn() };
    const { workspace, refs } = dashboardHarness(passiveLearning);
    expect(passiveLearning.mountHome).toHaveBeenCalledExactlyOnceWith(refs.learningContent, expect.any(Function));
    workspace.render({ ...loaded, composerAvailable: false });
    refs.learningContent.hidden = false;
    expect(refs.learning.hidden).toBe(true);
    workspace.render(loaded);
    expect(refs.learning.hidden).toBe(false);
    workspace.render({ ...loaded, composerAvailable: false });
    expect(refs.learning.hidden).toBe(true);
  });

  test("unavailable composer and Jobs expose no usable controls or empty-state templates", () => {
    const { workspace, refs } = dashboardHarness();
    workspace.render({
      ...loaded,
      supportsSchedules: false,
      composerAvailable: false,
    });
    expect(refs.composer.hidden).toBe(true);
    expect(refs.note.hidden).toBe(true);
    expect(refs.setup.hidden).toBe(false);
    expect(refs.overview.hidden).toBe(true);
    expect(refs.activity.innerHTML).toBe("");
    expect(workspace.setupHost).toBe(refs.setup);
    expect(refs.activity.innerHTML).not.toContain("data-template-id");
    workspace.render(loaded);
    expect(refs.composer.hidden).toBe(false);
    expect(refs.setup.hidden).toBe(true);
    expect(refs.overview.hidden).toBe(false);
  });
});
