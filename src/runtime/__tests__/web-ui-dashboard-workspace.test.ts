import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardWorkspace } from "../../web-ui/app/components/dashboard/workspace.js";

function dashboardHarness() {
  const element = () => ({
    innerHTML: "",
    hidden: false,
    disabled: false,
    setAttribute: vi.fn(),
  });
  const refs = {
    activity: element(),
    conversations: element(),
    composer: element(),
    setup: element(),
    note: element(),
    attach: element(),
    create: element(),
  };
  const nodes: Record<string, ReturnType<typeof element>> = {
    "[data-dashboard-activity]": refs.activity,
    "[data-dashboard-conversations]": refs.conversations,
    "[data-dashboard-composer]": refs.composer,
    "[data-dashboard-setup]": refs.setup,
    ".home-composer-note": refs.note,
    '[data-dashboard-action="attach"]': refs.attach,
    '[data-dashboard-action="create-job"]': refs.create,
  };
  type Button = { dataset: Record<string, string>; disabled?: boolean };
  type Click = { target: { closest: () => Button } };
  let click = (_event: Click) => {};
  const root = {
    innerHTML: "",
    classList: { add: vi.fn() },
    querySelector: (selector: string) => nodes[selector],
    contains: () => true,
    addEventListener: (_type: string, listener: typeof click) => {
      click = listener;
    },
  };
  const actions = {
    attach: vi.fn(),
    createJob: vi.fn(),
    continueConversation: vi.fn(),
    openConfiguration: vi.fn(),
    openJobs: vi.fn(),
    openConversation: vi.fn(),
    refresh: vi.fn(),
  };
  const workspace = createDashboardWorkspace({ root, actions });
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

  test("shortcuts preserve their callbacks and disabled shortcuts do nothing", () => {
    const { click, actions } = dashboardHarness();
    click({ dashboardAction: "attach" }, true);
    expect(actions.attach).not.toHaveBeenCalled();
    click({ dashboardAction: "attach" });
    click({ dashboardAction: "create-job" });
    click({ dashboardAction: "conversations" });
    click({ dashboardAction: "configuration" });
    click({ dashboardAction: "jobs" });
    click({ dashboardAction: "refresh" });
    for (const action of Object.values(actions).filter(
      (action) => action !== actions.openConversation,
    ))
      expect(action).toHaveBeenCalledOnce();
    expect(actions.openConversation).not.toHaveBeenCalled();
  });

  test("unavailable composer and Jobs expose no usable controls or empty-state templates", () => {
    const { workspace, refs } = dashboardHarness();
    workspace.render({
      ...loaded,
      supportsSchedules: false,
      composerAvailable: false,
    });
    expect(refs.attach.disabled).toBe(true);
    expect(refs.create.disabled).toBe(true);
    expect(refs.composer.hidden).toBe(true);
    expect(refs.note.hidden).toBe(true);
    expect(refs.setup.hidden).toBe(false);
    expect(workspace.setupHost).toBe(refs.setup);
    expect(refs.activity.innerHTML).not.toContain("data-template-id");
    workspace.render(loaded);
    expect(refs.attach.disabled).toBe(false);
    expect(refs.create.disabled).toBe(false);
    expect(refs.composer.hidden).toBe(false);
    expect(refs.setup.hidden).toBe(true);
  });
});
