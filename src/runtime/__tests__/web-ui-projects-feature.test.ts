import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser composition module has no declaration surface.
import { createProjectsFeature } from "../../web-ui/app/projects-feature.js";
// @ts-expect-error Browser rendering module has no declaration surface.
import { renderProjectSessionGroups } from "../../web-ui/app/components/project-session-groups.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { deferredProjectResult, project, projectClient } from "./support/projects-controller-fixture.js";
import type { SessionProject } from "../../sessions/project-binding.js";

const projectViewActions = vi.hoisted(() => ({ cancel: (): boolean => false }));
vi.mock("../../web-ui/app/components/project-creation.js", () => ({
  createProjectCreation: ({ actions }: { actions: { closeCreate: () => boolean } }) => {
    projectViewActions.cancel = actions.closeCreate;
    return { render: vi.fn() };
  },
}));
afterEach(() => vi.unstubAllGlobals());

class ProjectElement extends ContextElement {
  inert = false;
  title = "";
  value = "";
  focus = vi.fn();
  private markup = "";
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    this.replaceChildren();
    // Only event-target construction is needed; grouping assertions inspect real children.
    if (value.includes("<button")) this.appendChild(new ProjectElement("button"));
  }
}

type SessionItem = { id: string; projectId?: string; project?: SessionProject };

function groups(projects = [project()], sessions: SessionItem[] = [], query = "") {
  const root = new ProjectElement("div");
  const onNewConversation = vi.fn();
  const createSessionItem = vi.fn((session: SessionItem, _index: number) => {
    const item = new ProjectElement("article");
    item.dataset.sessionId = session.id;
    return item;
  });
  renderProjectSessionGroups({
    root, projects, sessions, query, createSessionItem, onNewConversation,
    onRetry: vi.fn(), loading: false, error: "", busyProjectId: "",
    documentRoot: { createElement: (tag: string) => new ProjectElement(tag) },
  });
  return { root, onNewConversation, createSessionItem };
}

function featureFixture(supported = true) {
  const client = projectClient();
  client.supportsProjects.mockReturnValue(supported);
  const element = () => new ProjectElement("div");
  const dom = {
    chatPanel: element(), messagesList: element(), composerForm: element(),
    projectCreationRoot: element(), newProjectButton: element(),
    newSessionButton: element(), sessionsList: element(), environmentSelect: element(),
    refreshSessionsButton: element(), currentProjectContext: element(),
  };
  dom.messagesList.appendChild(new ProjectElement("article"));
  dom.composerForm.value = "existing draft";
  const history = [{ id: "message-1", text: "existing history" }];
  const state = {
    currentSessionId: "existing", sessionViewVersion: 4, sessionQuery: "",
    messages: history, sessions: [{ id: "existing" }],
  };
  const conversationSession = {
    openSession: vi.fn(async (sessionId: string) => {
      state.currentSessionId = sessionId;
      state.sessionViewVersion += 1;
    }),
    loadSessions: vi.fn(async () => {}),
  };
  const prepareConversation = vi.fn(() => true);
  const shell = { showToast: vi.fn(), activateWorkspace: vi.fn(() => true), setSessionsDrawerOpen: vi.fn() };
  const onSessionCreated = vi.fn();
  const feature = createProjectsFeature({
    onSessionCreated,
    dom, state, client, shell, conversationSession,
    selectedEnvironmentId: () => "prod", renderSessions: vi.fn(),
    prepareConversation,
  });
  feature.bind();
  return { feature, client, dom, state, history, conversationSession, shell, prepareConversation, onSessionCreated };
}

function clickProjectHeader(fixture: ReturnType<typeof featureFixture>) {
  vi.stubGlobal("document", {
    createElement: (tag: string) => new ProjectElement(tag),
  });
  const root = new ProjectElement("div");
  fixture.feature.renderSessionGroups({
    root,
    sessions: [{ id: "project-child", project: project() }],
    createSessionItem: () => new ProjectElement("article"),
  });
  const header = root.children.find((child) => child.className === "project-session-group");
  expect(header).toBeDefined();
  header!.querySelector("button")!.dispatch("click");
}

describe("project draft UI ownership", () => {
  test("opening and Escape cancellation preserve the active conversation, history and composer", async () => {
    const f = featureFixture();
    const existingMessage = f.dom.messagesList.children[0];
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    expect(f.dom.chatPanel.classList.contains("project-creation-open")).toBe(true);
    expect(f.dom.messagesList.inert).toBe(true);
    expect(f.dom.composerForm.inert).toBe(true);
    f.dom.projectCreationRoot.dispatch("keydown", { key: "Escape", stopPropagation: vi.fn() });
    expect(f.dom.chatPanel.classList.contains("project-creation-open")).toBe(false);
    expect(f.dom.messagesList.inert).toBe(false);
    expect(f.dom.composerForm.inert).toBe(false);
    expect(f.dom.messagesList.children[0]).toBe(existingMessage);
    expect(f.dom.composerForm.value).toBe("existing draft");
    expect(f.state.currentSessionId).toBe("existing");
    expect(f.state.sessionViewVersion).toBe(4);
    expect(f.state.messages).toBe(f.history);
    expect(f.client.createProject).not.toHaveBeenCalled();
    expect(f.client.createProjectSession).not.toHaveBeenCalled();
    expect(f.conversationSession.openSession).not.toHaveBeenCalled();
  });

  test("form Cancel restores trigger focus once without stealing it during navigation", async () => {
    const f = featureFixture();
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    projectViewActions.cancel();
    expect(f.dom.newProjectButton.focus).toHaveBeenCalledOnce();
    expect(f.dom.messagesList.inert).toBe(false);
    expect(f.state.currentSessionId).toBe("existing");
    projectViewActions.cancel();
    expect(f.dom.newProjectButton.focus).toHaveBeenCalledOnce();

    f.dom.newProjectButton.focus.mockClear();
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    f.dom.newSessionButton.dispatch("click");
    expect(f.dom.newProjectButton.focus).not.toHaveBeenCalled();
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    f.feature.workspaceChanged("config");
    expect(f.dom.newProjectButton.focus).not.toHaveBeenCalled();
  });

  test("project header activation closes the existing creation draft without stealing focus", async () => {
    const f = featureFixture();
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    clickProjectHeader(f);
    await vi.waitFor(() => expect(f.conversationSession.openSession).toHaveBeenCalledWith("created-session"));
    expect(f.state.currentSessionId).toBe("created-session");
    expect(f.onSessionCreated).toHaveBeenCalledExactlyOnceWith("created-session");
    expect(f.onSessionCreated.mock.invocationCallOrder[0]).toBeLessThan(
      f.conversationSession.openSession.mock.invocationCallOrder[0],
    );
    expect(f.dom.chatPanel.classList.contains("project-creation-open")).toBe(false);
    expect(f.dom.messagesList.inert).toBe(false);
    expect(f.dom.composerForm.inert).toBe(false);
    expect(f.dom.newProjectButton.focus).not.toHaveBeenCalled();
  });

  test("project header navigation veto keeps the user's draft and avoids session creation", async () => {
    const f = featureFixture();
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    f.prepareConversation.mockReturnValueOnce(false);
    clickProjectHeader(f);
    expect(f.dom.chatPanel.classList.contains("project-creation-open")).toBe(true);
    expect(f.state.currentSessionId).toBe("existing");
    expect(f.client.createProjectSession).not.toHaveBeenCalled();
    expect(f.dom.newProjectButton.focus).not.toHaveBeenCalled();
  });

  test("project header persistence failure leaves the draft available for editing", async () => {
    const f = featureFixture();
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    f.client.createProjectSession.mockRejectedValueOnce(new Error("persist failed"));
    clickProjectHeader(f);
    await vi.waitFor(() => expect(f.shell.showToast).toHaveBeenCalledWith("persist failed", "failed"));
    expect(f.dom.chatPanel.classList.contains("project-creation-open")).toBe(true);
    expect(f.state.currentSessionId).toBe("existing");
    expect(f.conversationSession.openSession).not.toHaveBeenCalled();
    expect(f.dom.newProjectButton.focus).not.toHaveBeenCalled();
  });

  test("a session opening that declines activation does not discard the draft", async () => {
    const f = featureFixture();
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    f.conversationSession.openSession.mockResolvedValueOnce();
    clickProjectHeader(f);
    await vi.waitFor(() => expect(f.conversationSession.openSession).toHaveBeenCalled());
    expect(f.state.currentSessionId).toBe("existing");
    expect(f.dom.chatPanel.classList.contains("project-creation-open")).toBe(true);
  });

  test("a newer creation draft survives an older project session finishing its load", async () => {
    const f = featureFixture();
    const loading = deferredProjectResult<void>();
    f.conversationSession.openSession.mockImplementationOnce(async (sessionId: string) => {
      f.state.currentSessionId = sessionId;
      await loading.promise;
    });
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    clickProjectHeader(f);
    await vi.waitFor(() => expect(f.conversationSession.openSession).toHaveBeenCalled());
    f.dom.newProjectButton.dispatch("click");
    loading.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.dom.chatPanel.classList.contains("project-creation-open")).toBe(true);
    expect(f.dom.newProjectButton.focus).not.toHaveBeenCalled();
  });

  test("unavailable project UI neither browses nor activates a workspace", () => {
    const f = featureFixture(false);
    f.feature.refreshAvailability();
    f.dom.newProjectButton.dispatch("click");
    expect(f.dom.newProjectButton.disabled).toBe(true);
    expect(f.client.browseProjectFolders).not.toHaveBeenCalled();
    expect(f.shell.activateWorkspace).not.toHaveBeenCalled();
  });

  test("leaving the workspace clears the draft overlay without opening another session", async () => {
    const f = featureFixture();
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    f.feature.workspaceChanged("config");
    expect(f.dom.messagesList.inert).toBe(false);
    expect(f.dom.composerForm.inert).toBe(false);
    expect(f.state.currentSessionId).toBe("existing");
    expect(f.conversationSession.openSession).not.toHaveBeenCalled();
  });
});

describe("project conversation grouping", () => {
  test("keeps zero-session projects and project children before even the first ordinary session", () => {
    const { root, createSessionItem, onNewConversation } = groups(
      [project("empty-project"), project("populated")],
      [{ id: "ordinary-first" }, { id: "project-child", projectId: "populated" }],
    );
    const sections = root.children.filter((child) => child.className === "project-session-group");
    expect(sections).toHaveLength(2);
    expect(sections[0]?.children.some((child) => child.className === "project-empty-copy")).toBe(true);
    expect(sections[1]?.children.some((child) => child.dataset.sessionId === "project-child")).toBe(true);
    const ordinaryHeading = root.children.findIndex((child) => child.className.includes("ordinary-conversations-heading"));
    expect(root.children.indexOf(sections[1]!)).toBeLessThan(ordinaryHeading);
    expect(createSessionItem.mock.calls.map(([session]) => session.id)).toEqual(["project-child", "ordinary-first"]);
    sections[0]?.querySelector("button")?.dispatch("click");
    expect(onNewConversation).toHaveBeenCalledWith("empty-project");
  });

  test("saved project metadata groups children even when the project list is temporarily absent", () => {
    const { root } = groups([], [{ id: "saved-child", project: project("saved-project") }]);
    const group = root.children.find((child) => child.className === "project-session-group");
    expect(group?.children.some((child) => child.dataset.sessionId === "saved-child")).toBe(true);
  });

  test("renders many projects without a product cap and filters empty groups by directory", () => {
    const projects = Array.from({ length: 140 }, (_, index) => project(`project-${index}`));
    const all = groups(projects);
    expect(all.root.children.filter((child) => child.className === "project-session-group")).toHaveLength(140);
    const filtered = groups(projects, [], "/work/project-139");
    expect(filtered.root.children.filter((child) => child.className === "project-session-group")).toHaveLength(1);
  });
});
