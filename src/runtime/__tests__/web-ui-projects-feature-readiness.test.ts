import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module has no declaration surface.
import { createProjectsFeature } from "../../web-ui/app/projects-feature.js";
import type { ProjectCreationDraft } from "../../web-ui/app/controllers/projects-controller.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { projectClient } from "./support/projects-controller-fixture.js";

const projectView = vi.hoisted(() => ({ render: vi.fn(), updateDraft: (_field: string, _value: string) => {} }));
vi.mock("../../web-ui/app/components/project-creation.js", () => ({
  createProjectCreation: ({ actions }: { actions: { updateDraft: typeof projectView.updateDraft } }) => {
    projectView.updateDraft = actions.updateDraft;
    return { render: projectView.render };
  },
}));

class ProjectElement extends ContextElement {
  inert = false;
  title = "";
}

function fixture() {
  let ready = false;
  const element = () => new ProjectElement("div");
  const dom = { chatPanel: element(), messagesList: element(), composerForm: element(),
    projectCreationRoot: element(), newProjectButton: element(), newSessionButton: element(),
    sessionsList: element(), environmentSelect: element(), refreshSessionsButton: element(),
    currentProjectContext: element(), sessionsPanel: element(), sessionsToggleButton: element() };
  const client = projectClient();
  const state = { currentSessionId: "existing", sessionViewVersion: 1, sessions: [] };
  const shell = { showToast: vi.fn(), activateWorkspace: vi.fn<() => boolean | Promise<boolean>>(() => true), setSessionsDrawerOpen: vi.fn() };
  const conversationSession = { openSession: vi.fn(async () => {}), loadSessions: vi.fn(async () => {}) };
  projectView.render.mockClear();
  const feature = createProjectsFeature({ dom, client, state, shell, conversationSession,
    selectedEnvironmentId: () => "prod", isRuntimeReady: () => ready,
    renderSessions: vi.fn(), prepareConversation: vi.fn(() => true) });
  feature.bind();
  return { feature, dom, client, state, shell, conversationSession, setReady: (value: boolean) => { ready = value; } };
}

describe("Projects feature readiness wiring", () => {
  test("initial unavailable controls never activate chat and become usable after the canonical ready event", async () => {
    const f = fixture();
    f.feature.refreshAvailability();
    await f.feature.load();
    f.dom.newProjectButton.dispatch("click");
    expect(f.dom.newProjectButton.disabled).toBe(true);
    expect(f.shell.activateWorkspace).not.toHaveBeenCalled();
    expect(f.client.listProjects).not.toHaveBeenCalled();
    f.setReady(true);
    await f.feature.runtimeAvailabilityChanged();
    await f.feature.runtimeAvailabilityChanged();
    expect(f.dom.newProjectButton.disabled).toBe(false);
    expect(f.client.listProjects).toHaveBeenCalledExactlyOnceWith("prod");
    f.dom.newProjectButton.dispatch("click");
    expect(f.shell.activateWorkspace).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.dom.messagesList.inert).toBe(true));
  });

  test("readiness loss releases the draft overlay, then restores its input without touching the conversation", async () => {
    const f = fixture();
    f.setReady(true);
    await f.feature.runtimeAvailabilityChanged();
    f.dom.newProjectButton.dispatch("click");
    await vi.waitFor(() => expect(f.dom.messagesList.inert).toBe(true));
    projectView.updateDraft("name", "Unsubmitted project");
    projectView.updateDraft("directory", "/chosen/folder");
    f.setReady(false);
    await f.feature.runtimeAvailabilityChanged();
    expect(f.dom.chatPanel.classList.contains("project-creation-open")).toBe(false);
    expect(f.dom.messagesList.inert).toBe(false);
    expect(f.dom.composerForm.inert).toBe(false);
    expect(projectView.render).toHaveBeenLastCalledWith(null);
    f.setReady(true);
    await f.feature.runtimeAvailabilityChanged();
    const restored: ProjectCreationDraft = projectView.render.mock.calls.at(-1)![0];
    expect(restored).toMatchObject({ name: "Unsubmitted project", directory: "/chosen/folder", saving: false });
    await vi.waitFor(() => expect(f.dom.messagesList.inert).toBe(true));
    expect(f.state.currentSessionId).toBe("existing");
    expect(f.conversationSession.openSession).not.toHaveBeenCalled();
    expect(f.client.createProject).not.toHaveBeenCalled();
    expect(f.client.createProjectSession).not.toHaveBeenCalled();
  });
});

test.each(["cancel", "conversation", "ready", "approve"] as const)("project creation awaits workspace approval and rechecks %s", async (change) => {
  const f = fixture();
  f.setReady(true);
  await f.feature.runtimeAvailabilityChanged();
  let approve!: (value: boolean) => void;
  f.shell.activateWorkspace.mockImplementation(() => new Promise<boolean>((resolve) => { approve = resolve; }));
  f.dom.newProjectButton.dispatch("click");
  expect(f.dom.messagesList.inert).toBe(false);
  if (change === "conversation") f.state.sessionViewVersion += 1;
  if (change === "ready") f.setReady(false);
  approve(change !== "cancel");
  await Promise.resolve();
  expect(f.dom.messagesList.inert).toBe(change === "approve");
});
