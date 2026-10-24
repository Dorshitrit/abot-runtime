import { escapeHtml } from "./lib/text-format.js";
import { createProjectsController } from "./controllers/projects-controller.js";
import { createProjectCreation } from "./components/project-creation.js";
import { renderProjectSessionGroups } from "./components/project-session-groups.js";

export function createProjectsFeature({
  dom,
  state,
  preferences,
  confirmAction,
  client,
  shell,
  selectedEnvironmentId,
  isRuntimeReady = () => true,
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
    confirmAction,
    getEnvironmentId: selectedEnvironmentId,
    isRuntimeReady,
    getConversationRevision: () =>
      `${state.currentSessionId}:${state.sessionViewVersion}`,
    prepareConversation,
    openSession: activateProjectConversation,
    loadSessions: conversationSession.loadSessions,
    notify: shell.showToast,
    onSessionCreated,
    onChange: (snapshot) => {
      const open = Boolean(snapshot.draft) && isRuntimeReady();
      dom.chatPanel.classList.toggle("project-creation-open", open);
      dom.messagesList.inert = open;
      dom.composerForm.inert = open;
      view?.render(open ? snapshot.draft : null);
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
    if (groupEnvironmentId !== environmentId) {
      groupEnvironmentId = environmentId;
      collapsedProjectIds.clear();
      expandedProjectSessionIds.clear();
    }
    const saved = preferences?.loadCollapsedProjectIds?.(environmentId);
    if (!saved) return;
    collapsedProjectIds.clear();
    for (const projectId of saved) collapsedProjectIds.add(projectId);
  }

  async function rememberProjectGroupCollapse(projectId, collapsed) {
    syncProjectGroupEnvironment();
    const isSearchingSessions = Boolean(String(state.sessionQuery ?? "").trim());
    if (isSearchingSessions) return;
    collapsedProjectIds.delete(projectId);
    if (collapsed) collapsedProjectIds.add(projectId);
    try {
      await preferences?.saveCollapsedProjectIds?.(groupEnvironmentId, [...collapsedProjectIds]);
    } catch {
      renderSessions();
      shell.showToast("Could not save project visibility in ABot", "failed");
    }
  }

  async function requestProjectDeletion(projectId, projectName) {
    const environmentId = selectedEnvironmentId();
    await controller.deleteProject(projectId, projectName);
    if (selectedEnvironmentId() !== environmentId) return;
    if (dom.sessionsPanel.hidden) return;
    const documentRoot = dom.sessionsList.ownerDocument;
    if (!documentRoot) return;
    if (documentRoot.activeElement !== documentRoot.body) return;
    dom.newProjectButton.focus();
  }

  function rememberProjectSessionExpansion(projectId, expanded) {
    syncProjectGroupEnvironment();
    if (expanded) {
      expandedProjectSessionIds.add(projectId);
      return;
    }
    expandedProjectSessionIds.delete(projectId);
  }

  function canUseProjects() {
    if (!isRuntimeReady()) return false;
    return client.supportsProjects();
  }

  function refreshAvailability() {
    const available = canUseProjects();
    dom.newProjectButton.disabled = !available;
    dom.newProjectButton.title = available
      ? "Create a project"
      : "Projects are currently unavailable";
  }

  return {
    load: controller.load,
    getDeletedProjectIds: controller.getDeletedProjectIds,
    refreshAvailability,
    runtimeAvailabilityChanged() {
      refreshAvailability();
      return controller.runtimeAvailabilityChanged();
    },
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
        newProjectButton: dom.newProjectButton,
        ...controller.snapshot(),
        deletedProjectIds: controller.getDeletedProjectIds(),
        query: state.sessionQuery,
        collapsedProjectIds,
        expandedProjectSessionIds,
        onToggleGroup: rememberProjectGroupCollapse,
        onToggleProjectSessions: rememberProjectSessionExpansion,
        onNewConversation: controller.newConversation,
        onDeleteProject: requestProjectDeletion,
        onRetry: () => void controller.load(),
      });
      return true;
    },
    bind() {
      dom.newProjectButton.addEventListener("click", async () => {
        if (!canUseProjects()) return;
        const environmentId = selectedEnvironmentId();
        const conversationRevision = JSON.stringify([state.currentSessionId, state.sessionViewVersion]);
        if (!await shell.activateWorkspace("chat", { focus: false })) return;
        if (environmentId !== selectedEnvironmentId() || !canUseProjects()) return;
        if (conversationRevision !== JSON.stringify([state.currentSessionId, state.sessionViewVersion])) return;
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
