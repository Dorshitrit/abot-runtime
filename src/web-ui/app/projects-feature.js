import { escapeHtml } from "./lib/text-format.js";
import { createProjectsController } from "./controllers/projects-controller.js";
import { createProjectCreation } from "./components/project-creation.js";
import { renderProjectSessionGroups } from "./components/project-session-groups.js";

export function createProjectsFeature({
  dom,
  state,
  client,
  shell,
  selectedEnvironmentId,
  conversationSession,
  renderSessions,
  prepareConversation,
  closeFilePreview = () => {},
  onSessionCreated = () => {},
}) {
  let view;
  let wasOpen = false;
  let groupEnvironmentId = selectedEnvironmentId();
  const collapsedProjectIds = new Set();
  const expandedProjectSessionIds = new Set();
  const controller = createProjectsController({
    client,
    getEnvironmentId: selectedEnvironmentId,
    getConversationRevision: () =>
      `${state.currentSessionId}:${state.sessionViewVersion}`,
    prepareConversation,
    openSession: activateProjectConversation,
    loadSessions: conversationSession.loadSessions,
    notify: shell.showToast,
    onSessionCreated,
    onChange: (snapshot) => {
      const open = Boolean(snapshot.draft);
      dom.chatPanel.classList.toggle("project-creation-open", open);
      dom.messagesList.inert = open;
      dom.composerForm.inert = open;
      view?.render(snapshot.draft);
      renderSessions();
      if (open && !wasOpen)
        dom.projectCreationRoot.querySelector("input")?.focus();
      wasOpen = open;
    },
  });
  view = createProjectCreation({
    root: dom.projectCreationRoot,
    actions: { ...controller, closeCreate },
  });

  function canCloseDraftAfterProjectActivation(sessionId, draft) {
    if (!draft) return false;
    if (state.currentSessionId !== sessionId) return false;
    return controller.snapshot().draft === draft;
  }

  async function activateProjectConversation(sessionId) {
    const draft = controller.snapshot().draft;
    await conversationSession.openSession(sessionId);
    if (!canCloseDraftAfterProjectActivation(sessionId, draft)) return;
    controller.closeCreate();
  }

  function closeCreate() {
    const hadOpenDraft = Boolean(controller.snapshot().draft);
    const closed = controller.closeCreate();
    if (!hadOpenDraft) return closed;
    if (!closed) return closed;
    const focusTarget = dom.sessionsPanel.hidden
      ? dom.sessionsToggleButton
      : dom.newProjectButton;
    focusTarget.focus();
    return closed;
  }

  function syncProjectGroupEnvironment() {
    const environmentId = selectedEnvironmentId();
    if (groupEnvironmentId === environmentId) return;
    groupEnvironmentId = environmentId;
    collapsedProjectIds.clear();
    expandedProjectSessionIds.clear();
  }

  function rememberProjectGroupCollapse(projectId, collapsed) {
    syncProjectGroupEnvironment();
    const isSearchingSessions = Boolean(String(state.sessionQuery ?? "").trim());
    if (isSearchingSessions) return;
    if (collapsed) {
      collapsedProjectIds.add(projectId);
      return;
    }
    collapsedProjectIds.delete(projectId);
  }

  function rememberProjectSessionExpansion(projectId, expanded) {
    syncProjectGroupEnvironment();
    if (expanded) {
      expandedProjectSessionIds.add(projectId);
      return;
    }
    expandedProjectSessionIds.delete(projectId);
  }

  function refreshAvailability() {
    const available = client.supportsProjects();
    dom.newProjectButton.disabled = !available;
    dom.newProjectButton.title = available
      ? "Create a project"
      : "Projects are unavailable on this server";
  }

  return {
    load: controller.load,
    refreshAvailability,
    renderSessionGroups({ root, sessions, createSessionItem }) {
      syncProjectGroupEnvironment();
      const project = state.sessions.find(
        (session) => session.id === state.currentSessionId,
      )?.project;
      dom.currentProjectContext.hidden = !project;
      dom.currentProjectContext.innerHTML = project
        ? `<bdi class="current-project-name" dir="auto">${escapeHtml(project.name)}</bdi>
           <span aria-hidden="true">·</span>
           <bdi class="current-project-path" dir="ltr">${escapeHtml(project.directory)}</bdi>`
        : "";
      dom.currentProjectContext.title = project?.directory || "";
      if (!client.supportsProjects()) return false;
      renderProjectSessionGroups({
        root,
        sessions,
        createSessionItem,
        ...controller.snapshot(),
        query: state.sessionQuery,
        collapsedProjectIds,
        expandedProjectSessionIds,
        onToggleGroup: rememberProjectGroupCollapse,
        onToggleProjectSessions: rememberProjectSessionExpansion,
        onNewConversation: controller.newConversation,
        onRetry: () => void controller.load(),
      });
      return true;
    },
    bind() {
      dom.newProjectButton.addEventListener("click", () => {
        if (!client.supportsProjects()) return;
        if (!shell.activateWorkspace("chat", { focus: false })) return;
        shell.setSessionsDrawerOpen(false);
        closeFilePreview();
        controller.openCreate();
      });
      dom.projectCreationRoot.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        closeCreate();
      });
      dom.newSessionButton.addEventListener("click", () =>
        controller.closeCreate(),
      );
      dom.sessionsList.addEventListener("click", (event) => {
        if (event.target.closest(".session-open-button"))
          controller.closeCreate();
      });
      dom.environmentSelect.addEventListener("change", () => {
        queueMicrotask(() => {
          syncProjectGroupEnvironment();
          refreshAvailability();
          void controller.environmentChanged();
        });
      });
      dom.refreshSessionsButton.addEventListener(
        "click",
        () => void controller.load(),
      );
    },
    workspaceChanged(workspace) {
      if (workspace !== "chat") controller.closeCreate();
    },
  };
}
