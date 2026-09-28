import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardWorkspace } from "../../web-ui/app/components/dashboard/workspace.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

function dashboardHarness(passiveLearning?: { mountHome: ReturnType<typeof vi.fn> }) {
  const element = () => ({
    innerHTML: "",
    hidden: false,
    disabled: false,
    setAttribute: vi.fn(),
    ownerDocument: { activeElement: null },
    querySelectorAll: () => [],
    contains: () => false,
  });
  const refs = {
    learning: element(),
    learningContent: element(),
    overview: element(),
    activity: element(),
    conversations: element(),
    composer: element(),
    setup: element(),
    note: element(),
    approvals: Object.assign(new ContextElement("section"), { innerHTML: "" }),
    content: Object.assign(new ContextElement("div"), { innerHTML: "" }),
    dock: Object.assign(new ContextElement("div"), { innerHTML: "" }),
  };
  const nodes: Record<string, ReturnType<typeof element>> = {
    "[data-dashboard-learning]": refs.learning,
    "[data-dashboard-learning-content]": refs.learningContent,
    ".home-overview": refs.overview,
    "[data-dashboard-activity]": refs.activity,
    "[data-dashboard-conversations]": refs.conversations,
    "[data-dashboard-approvals]": refs.approvals as unknown as ReturnType<
      typeof element
    >,
    ".home-workspace-content": refs.content as unknown as ReturnType<
      typeof element
    >,
    "[data-dashboard-approval-dock]": refs.dock as unknown as ReturnType<
      typeof element
    >,
    "[data-dashboard-composer]": refs.composer,
    "[data-dashboard-setup]": refs.setup,
    ".home-composer-note": refs.note,
  };
  type Button = { dataset: Record<string, string>; disabled?: boolean };
  type Click = { target: { closest: () => Button } };
  let click = (_event: Click) => {};
  const root = {
    ownerDocument: {
      createElement: (tagName: string) => new ContextElement(tagName),
    },
    innerHTML: "",
    classList: { add: vi.fn(), toggle: vi.fn() },
    querySelector: (selector: string) => nodes[selector],
    contains: () => true,
    addEventListener: (_type: string, listener: typeof click) => {
      click = listener;
    },
  };
  const actions = {
    createJob: vi.fn(),
    continueConversation: vi.fn(),
    openJobs: vi.fn(),
    openConversation: vi.fn(),
    refresh: vi.fn(),
  };
  const workspace = createDashboardWorkspace({ root, actions, passiveLearning });
  return {
    workspace,
    root,
    refs,
    actions,
    click: (dataset: Record<string, string>, disabled = false) =>
      click({ target: { closest: () => ({ dataset, disabled }) } }),
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
    workspace.render(loaded);
    workspace.render({
      ...loaded,
      sessions: [{ ...loaded.sessions[0], unreadCount: 0 }],
      runs: [{ id: "run-one", title: "Done", status: "succeeded" }],
    });
    expect(workspace.composerHost).toBe(refs.composer);
    expect(refs.composer.innerHTML).toBe(
      "<form data-existing-composer>Draft</form>",
    );
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
    expect(passiveLearning.mountHome).toHaveBeenCalledExactlyOnceWith(refs.learningContent);
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
