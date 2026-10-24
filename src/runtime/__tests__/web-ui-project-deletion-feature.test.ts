import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module.
import { createProjectsFeature } from "../../web-ui/app/projects-feature.js";
import { SidebarElement } from "./support/session-sidebar-dom.js";
import { project, projectClient } from "./support/projects-controller-fixture.js";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const element = () => new SidebarElement("div");
  const dom = {
    chatPanel: element(), messagesList: element(), composerForm: element(),
    projectCreationRoot: element(), newProjectButton: element(),
    newSessionButton: element(), sessionsList: element(), environmentSelect: element(),
    refreshSessionsButton: element(), currentProjectContext: element(),
    sessionsPanel: element(), sessionsToggleButton: element(),
  };
  const binding = Object.freeze(project("historical"));
  const session = Object.freeze({ id: "current", project: binding });
  const state = { sessions: [session], currentSessionId: "current", sessionViewVersion: 4, sessionQuery: "" };
  const client = projectClient();
  const confirmAction = vi.fn(() => true);
  const shell = { showToast: vi.fn() };
  vi.stubGlobal("document", { createElement: (tag: string) => new SidebarElement(tag) });
  const renderSessions = vi.fn(() => {
    dom.sessionsList.replaceChildren();
    feature.renderSessionGroups({
      root: dom.sessionsList, sessions: state.sessions,
      createSessionItem: (value: { id: string }) => {
        const item = element();
        item.dataset.sessionId = value.id;
        return item;
      },
    });
  });
  const loadSessions = vi.fn(async () => {});
  const feature = createProjectsFeature({
    dom, state, client, confirmAction, shell, renderSessions,
    selectedEnvironmentId: () => "prod", prepareConversation: vi.fn(),
    conversationSession: { loadSessions, openSession: vi.fn() },
  });
  renderSessions();
  return { dom, state, binding, feature, client, confirmAction, shell, loadSessions,
    remove: () => dom.sessionsList.querySelector(".project-delete-action")!.dispatch("click"),
  };
}

test("historical groups expose a settings menu while the project title still toggles and plus stays separate", () => {
  const f = fixture();
  const group = f.dom.sessionsList.querySelector(".project-session-group")!;
  const title = group.querySelector(".project-group-toggle")!;
  const settings = group.querySelector(".session-menu-button")!;
  const menu = group.querySelector(".session-menu")!;
  expect(title.querySelector(".project-group-chevron")).toBeNull();
  expect(settings.getAttribute("aria-label")).toBe("Settings for historical");
  expect(settings.getAttribute("aria-haspopup")).toBe("menu");
  expect(settings.getAttribute("aria-controls")).toBe(menu.id);
  expect(menu.hidden).toBe(true);
  expect(group.querySelector(".project-group-new")).not.toBeNull();
  title.dispatch("click");
  expect(title.getAttribute("aria-expanded")).toBe("false");
  expect(f.client.deleteProject).not.toHaveBeenCalled();
});

test("cancel keeps the project and session binding and returns focus to its settings control", () => {
  const f = fixture();
  f.confirmAction.mockReturnValue(false);
  const settings = f.dom.sessionsList.querySelector(".session-menu-button") as SidebarElement;
  f.remove();
  expect(settings.focus).toHaveBeenCalledOnce();
  expect(f.client.deleteProject).not.toHaveBeenCalled();
  expect(f.dom.sessionsList.querySelector(".project-session-group")).not.toBeNull();
  expect(f.state.sessions[0]?.project).toBe(f.binding);
});

test("deleting an inferred historical group moves its chat to the general list without changing snapshot or active chat", async () => {
  const f = fixture();
  f.remove();
  await vi.waitFor(() => expect(f.loadSessions).toHaveBeenCalledOnce());
  expect(f.client.deleteProject).toHaveBeenCalledExactlyOnceWith("historical", "prod");
  expect(f.feature.getDeletedProjectIds()).toEqual(["historical"]);
  expect(f.dom.sessionsList.querySelector(".project-session-group")).toBeNull();
  expect(f.dom.sessionsList.children.some((item) => item.dataset.sessionId === "current")).toBe(true);
  expect(f.state.currentSessionId).toBe("current");
  expect(f.state.sessions[0]?.project).toBe(f.binding);
  expect(f.dom.currentProjectContext.title).toBe(f.binding.directory);
  expect(f.shell.showToast).not.toHaveBeenCalled();
});
