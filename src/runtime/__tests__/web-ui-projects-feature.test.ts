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
  const onToggleGroup = vi.fn();
  const createSessionItem = vi.fn((session: SessionItem, _index: number) => {
    const item = new ProjectElement("article");
    item.dataset.sessionId = session.id;
    return item;
  });
  renderProjectSessionGroups({
    root, projects, sessions, query, createSessionItem, onNewConversation, onToggleGroup,
    onRetry: vi.fn(), loading: false, error: "", busyProjectId: "",
    documentRoot: { createElement: (tag: string) => new ProjectElement(tag) },
  });
  return { root, onNewConversation, onToggleGroup, createSessionItem };
}

function featureFixture(supported = true) {
  let environmentId = "prod";
  const client = projectClient();
  client.supportsProjects.mockReturnValue(supported);
  const element = () => new ProjectElement("div");
  const dom = {
    chatPanel: element(), messagesList: element(), composerForm: element(),
    projectCreationRoot: element(), newProjectButton: element(),
    newSessionButton: element(), sessionsList: element(), environmentSelect: element(),
    refreshSessionsButton: element(), currentProjectContext: element(),
    sessionsPanel: element(), sessionsToggleButton: element(),
  };
  dom.messagesList.appendChild(new ProjectElement("article"));
  dom.composerForm.value = "existing draft";
  const history = [{ id: "message-1", text: "existing history" }];
  const state = {
    currentSessionId: "existing", sessionViewVersion: 4, sessionQuery: "",
    messages: history, sessions: [{ id: "existing" }] as SessionItem[],
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
    selectedEnvironmentId: () => environmentId, renderSessions: vi.fn(),
    prepareConversation,
  });
  feature.bind();
  return { feature, client, dom, state, history, conversationSession, shell, prepareConversation, onSessionCreated,
    setEnvironment: (value: string) => { environmentId = value; },
  };
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
  header!.querySelector(".project-group-new")!.dispatch("click");
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

  test("cancelling a project focuses the conversations control when its sidebar is hidden", async () => {
    const f = featureFixture();
    f.dom.sessionsPanel.hidden = true;
    f.dom.newProjectButton.dispatch("click");
    await Promise.resolve();
    projectViewActions.cancel();
    expect(f.dom.sessionsToggleButton.focus).toHaveBeenCalledOnce();
    expect(f.dom.newProjectButton.focus).not.toHaveBeenCalled();
    expect(f.state.currentSessionId).toBe("existing");
    expect(f.client.createProject).not.toHaveBeenCalled();
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
    expect(sections[0]?.querySelector(".project-group-content")?.children.some((child) => child.className === "project-empty-copy")).toBe(true);
    expect(sections[1]?.querySelector(".project-session-rows")?.children.some((child) => child.dataset.sessionId === "project-child")).toBe(true);
    const ordinaryHeading = root.children.findIndex((child) => child.className.includes("ordinary-conversations-heading"));
    expect(root.children.indexOf(sections[1]!)).toBeLessThan(ordinaryHeading);
    expect(createSessionItem.mock.calls.map(([session]) => session.id)).toEqual(["project-child", "ordinary-first"]);
    sections[0]?.querySelector(".project-group-new")?.dispatch("click");
    expect(onNewConversation).toHaveBeenCalledWith("empty-project");
  });

  test("saved project metadata groups children even when the project list is temporarily absent", () => {
    const { root } = groups([], [{ id: "saved-child", project: project("saved-project") }]);
    const group = root.children.find((child) => child.className === "project-session-group");
    expect(group?.querySelector(".project-session-rows")?.children.some((child) => child.dataset.sessionId === "saved-child")).toBe(true);
  });

  test("renders many projects without a product cap and filters empty groups by directory", () => {
    const projects = Array.from({ length: 140 }, (_, index) => project(`project-${index}`));
    const all = groups(projects);
    expect(all.root.children.filter((child) => child.className === "project-session-group")).toHaveLength(140);
    const filtered = groups(projects, [], "/work/project-139");
    expect(filtered.root.children.filter((child) => child.className === "project-session-group")).toHaveLength(1);
  });
});

function renderFeatureGroups(fixture: ReturnType<typeof featureFixture>) {
  vi.stubGlobal("document", { createElement: (tag: string) => new ProjectElement(tag) });
  const root = new ProjectElement("div");
  fixture.feature.renderSessionGroups({
    root,
    sessions: [
      { id: "first-child", project: project("first") },
      { id: "second-child", project: project("second") },
      { id: "ordinary" },
    ],
    createSessionItem: (session: SessionItem) => {
      const item = new ProjectElement("article");
      item.dataset.sessionId = session.id;
      return item;
    },
  });
  const sections = root.children.filter((child) => child.className === "project-session-group");
  return {
    root,
    firstToggle: sections[0]!.querySelector(".project-group-toggle")!,
    firstContent: sections[0]!.querySelector(".project-group-content")!,
    secondToggle: sections[1]!.querySelector(".project-group-toggle")!,
    secondContent: sections[1]!.querySelector(".project-group-content")!,
  };
}

describe("project group disclosure", () => {
  test("defaults open and toggles one group's contents without replacing its controls or affecting ordinary sessions", () => {
    const { root, onToggleGroup, onNewConversation } = groups(
      [project("first"), project("second")],
      [{ id: "one", projectId: "first" }, { id: "two", projectId: "second" }, { id: "ordinary" }],
    );
    const sections = root.children.filter((child) => child.className === "project-session-group");
    const toggle = sections[0]!.querySelector(".project-group-toggle")!;
    const content = sections[0]!.querySelector(".project-group-content")!;
    const siblingContent = sections[1]!.querySelector(".project-group-content")!;
    const ordinary = root.children.find((child) => child.dataset.sessionId === "ordinary");
    expect(toggle.tagName).toBe("button");
    const title = toggle.querySelector(".project-group-title")!;
    expect(title.parentElement).toBe(toggle);
    expect(toggle.querySelector(".project-group-chevron")?.getAttribute("aria-hidden")).toBe("true");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(content.id);
    expect(content.hidden).toBe(false);
    toggle.dispatch("click", { target: title });
    expect(content.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(sections[0]!.querySelector(".project-group-toggle")).toBe(toggle);
    expect(siblingContent.hidden).toBe(false);
    expect(root.children).toContain(ordinary);
    expect(onToggleGroup).toHaveBeenLastCalledWith("first", true);
    expect(onNewConversation).not.toHaveBeenCalled();
    toggle.dispatch("click");
    expect(content.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(onToggleGroup).toHaveBeenLastCalledWith("first", false);
    sections[0]!.querySelector(".project-group-new")!.dispatch("click");
    expect(onNewConversation).toHaveBeenCalledExactlyOnceWith("first");
  });

  test("retains separate collapsed choices after the session controller clears and recreates the list", () => {
    const f = featureFixture();
    const initial = renderFeatureGroups(f);
    initial.firstToggle.dispatch("click");
    initial.root.replaceChildren();
    const refreshed = renderFeatureGroups(f);
    expect(refreshed.firstContent.hidden).toBe(true);
    expect(refreshed.secondContent.hidden).toBe(false);
    refreshed.secondToggle.dispatch("click");
    refreshed.firstToggle.dispatch("click");
    const next = renderFeatureGroups(f);
    expect(next.firstContent.hidden).toBe(false);
    expect(next.secondContent.hidden).toBe(true);
    expect(f.state.currentSessionId).toBe("existing");
    expect(f.conversationSession.openSession).not.toHaveBeenCalled();
    expect(f.client.createProjectSession).not.toHaveBeenCalled();
  });

  test("search reveals matches and restores saved group choices without persisting transient search toggles", () => {
    const f = featureFixture();
    renderFeatureGroups(f).firstToggle.dispatch("click");
    f.state.sessionQuery = "  matching conversation  ";
    const search = renderFeatureGroups(f);
    expect(search.firstContent.hidden).toBe(false);
    expect(search.secondContent.hidden).toBe(false);
    search.secondToggle.dispatch("click");
    expect(search.secondContent.hidden).toBe(true);
    expect(renderFeatureGroups(f).secondContent.hidden).toBe(false);
    f.state.sessionQuery = "   ";
    const restored = renderFeatureGroups(f);
    expect(restored.firstContent.hidden).toBe(true);
    expect(restored.secondContent.hidden).toBe(false);
  });

  test("clears collapsed choices when switching environments, including returning to the original one", async () => {
    const f = featureFixture();
    renderFeatureGroups(f).firstToggle.dispatch("click");
    f.setEnvironment("dev");
    f.dom.environmentSelect.dispatch("change");
    await Promise.resolve();
    const switched = renderFeatureGroups(f);
    expect(switched.firstContent.hidden).toBe(false);
    switched.firstToggle.dispatch("click");
    f.setEnvironment("prod");
    f.dom.environmentSelect.dispatch("change");
    await Promise.resolve();
    expect(renderFeatureGroups(f).firstContent.hidden).toBe(false);
  });
});


describe("conversation project identity", () => {
  test("isolates RTL names from LTR paths, escapes both, and clears metadata for an ordinary conversation", () => {
    const f = featureFixture(false);
    f.state.sessions = [{
      id: "existing", project: {
        ...project(), name: 'פרויקט <script>alert("name")</script>',
        directory: '/work/תיקייה/<img src=x>&notes',
      },
    }];
    const render = () => f.feature.renderSessionGroups({
      root: new ProjectElement("div"), sessions: [], createSessionItem: vi.fn(),
    });
    render();
    expect(f.dom.currentProjectContext.hidden).toBe(false);
    expect(f.dom.currentProjectContext.innerHTML).toContain('class="current-project-name" dir="auto"');
    expect(f.dom.currentProjectContext.innerHTML).toContain('class="current-project-path" dir="ltr"');
    expect(f.dom.currentProjectContext.innerHTML).toContain('פרויקט &lt;script&gt;');
    expect(f.dom.currentProjectContext.innerHTML).toContain('/work/תיקייה/&lt;img src=x&gt;&amp;notes');
    expect(f.dom.currentProjectContext.innerHTML).not.toContain('<script>');
    expect(f.dom.currentProjectContext.innerHTML).not.toContain('<img');
    expect(f.dom.currentProjectContext.title).toBe('/work/תיקייה/<img src=x>&notes');
    f.state.currentSessionId = "ordinary";
    render();
    expect(f.dom.currentProjectContext.hidden).toBe(true);
    expect(f.dom.currentProjectContext.innerHTML).toBe("");
    expect(f.dom.currentProjectContext.title).toBe("");
  });
});
