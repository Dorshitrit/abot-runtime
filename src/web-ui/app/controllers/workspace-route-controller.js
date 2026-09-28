import {
  configuredRouteEnvironment,
  readWorkspaceRoute,
  workspaceRouteUrl,
} from "../lib/workspace-route.js";
import { configurationCategoryForWorkspace } from "../lib/configuration-pages.js";

export function createWorkspaceRouteController({
  viewport = window,
  shell,
  configuration,
  selection,
  getEnvironmentId,
  getSessionId,
  changeEnvironment,
  isEnvironmentChanging = () => false,
  loadSessions,
  openSession,
  restoreLastSession,
  schedules,
}) {
  let initialRoute = readWorkspaceRoute(viewport.location);
  let pendingInitialHistory = null;
  let ready = false;
  let applying = false;
  let syncQueued = false;
  let bound = false;
  let historyIndex = existingWorkspaceHistoryIndex(viewport.history.state);
  let acceptedUrl = "";
  let restoreQueue = Promise.resolve();

  function currentRoute() {
    return {
      workspace: shell.activeWorkspace(),
      environment: getEnvironmentId(),
      session: getSessionId(),
      category: configurationCategoryForWorkspace(shell.activeWorkspace()),
      tab: shell.activeOperationsTab(),
      job: schedules.selectedJobId(),
    };
  }

  function replaceCurrentUrl() {
    acceptedUrl = workspaceRouteUrl(currentRoute());
    viewport.history.replaceState(
      { ...viewport.history.state, abotWorkspaceIndex: historyIndex },
      "",
      acceptedUrl,
    );
  }

  function sync({ replace = false } = {}) {
    if (!ready) return;
    if (applying) return;
    if (syncQueued) return;
    if (isEnvironmentChanging()) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      if (!ready) return;
      if (applying) return;
      if (isEnvironmentChanging()) return;
      const nextUrl = workspaceRouteUrl(currentRoute());
      if (nextUrl === acceptedUrl) return;
      if (replace) {
        replaceCurrentUrl();
        return;
      }
      historyIndex += 1;
      acceptedUrl = nextUrl;
      viewport.history.pushState(
        { abotWorkspaceIndex: historyIndex },
        "",
        nextUrl,
      );
    });
  }

  function bootstrapEnvironment(options, saved, fallback) {
    if (configuredRouteEnvironment(initialRoute.environment, options))
      return initialRoute.environment;
    if (configuredRouteEnvironment(saved, options)) return saved;
    return fallback;
  }

  function routeEnvironmentIsAvailable(route) {
    if (!route.environment) return true;
    return configuredRouteEnvironment(
      route.environment,
      selection.environmentOptions(),
    );
  }

  function routeWorkspaceIsAvailable(route) {
    return shell.isWorkspaceAvailable(route.workspace);
  }

  function routeBackendIsAvailable(route) {
    return shell.isWorkspaceSupportedByBackend(route.workspace);
  }

  function routeNavigationRevisions() {
    return {
      shell: shell.navigationRevision(),
      configuration: configuration.navigationRevision(),
      schedules: schedules.navigationRevision(),
    };
  }

  function hasCurrentRouteNavigation(revisions) {
    if (shell.navigationRevision() !== revisions.shell) return false;
    if (configuration.navigationRevision() !== revisions.configuration)
      return false;
    return schedules.navigationRevision() === revisions.schedules;
  }

  async function restoreSession(
    route,
    initial,
    environmentId,
    routeActivationIsCurrent,
    commitLinkedConversationRoute,
  ) {
    if (!routeCarriesConversation(route)) {
      if (initial) await restoreLastSession();
      return true;
    }
    if (route.session === getSessionId()) return true;
    const sessions = await loadSessions();
    if (!routeActivationIsCurrent()) return false;
    if (environmentId !== getEnvironmentId()) return false;
    if (!routeSessionIsListed(route, sessions)) {
      shell.showToast(
        "This conversation is unavailable in the selected environment.",
        "failed",
      );
      return false;
    }
    let routeCommitted = false;
    await openSession(route.session, {
      isRouteCurrent: routeActivationIsCurrent,
      commitRouteNavigation: () => {
        routeCommitted = commitLinkedConversationRoute();
        return routeCommitted;
      },
    });
    if (!routeCommitted) return false;
    if (!routeActivationIsCurrent()) return false;
    if (environmentId !== getEnvironmentId()) return false;
    return getSessionId() === route.session;
  }

  async function applyRoute(route, { initial = false } = {}) {
    if (!routeEnvironmentIsAvailable(route)) {
      shell.showToast("This environment is no longer available.", "failed");
      return false;
    }
    if (!routeBackendIsAvailable(route)) {
      shell.showToast("This workspace is unavailable with the current backend.", "failed");
      return false;
    }
    const navigationRevisions = routeNavigationRevisions();
    if (routeChangesEnvironment(route, getEnvironmentId())) {
      if (
        !(await changeEnvironment(route.environment, { restoreSession: false }))
      )
        return false;
    }
    if (!hasCurrentRouteNavigation(navigationRevisions)) return false;
    if (!routeWorkspaceIsAvailable(route)) {
      shell.showToast(
        shell.workspaceUnavailableMessage?.() || "This workspace is unavailable with the current backend.",
        "failed",
      );
      return false;
    }
    const environmentId = getEnvironmentId();
    const activate = shell.prepareWorkspaceActivation(route.workspace, {
      focus: false,
    });
    if (!activate) return false;
    let linkedConversationActivated = false;
    function routeActivationIsCurrent() {
      if (!hasCurrentRouteNavigation(navigationRevisions)) return false;
      if (environmentId !== getEnvironmentId()) return false;
      return !initialRouteWasSuperseded(initial, pendingInitialHistory);
    }
    function commitLinkedConversationRoute() {
      if (!routeActivationIsCurrent()) return false;
      if (!activate()) return false;
      navigationRevisions.shell = shell.navigationRevision();
      linkedConversationActivated = true;
      return true;
    }
    if (
      !(await restoreSession(
        route,
        initial,
        environmentId,
        routeActivationIsCurrent,
        commitLinkedConversationRoute,
      ))
    )
      return false;
    if (!routeActivationIsCurrent()) return false;
    if (!linkedConversationActivated && !activate()) return false;
    const category = configurationCategoryForWorkspace(route.workspace);
    if (category) {
      if (configuration.activateCategory(category) === false)
        return false;
    }
    if (route.workspace === "config") {
      shell.activateOperationsTab(route.tab || "runtime");
    }
    if (route.workspace === "schedules") {
      return await schedules.openJob(route.job || "");
    }
    return true;
  }

  async function restoreInitial() {
    applying = true;
    const requestedHistory = pendingInitialHistory;
    pendingInitialHistory = null;
    if (Number.isInteger(requestedHistory?.targetIndex))
      historyIndex = requestedHistory.targetIndex;
    try {
      const route = { ...initialRoute };
      if (!route.environment) route.environment = getEnvironmentId();
      // An unknown environment must never resolve a same-named session elsewhere.
      if (!routeEnvironmentIsAvailable(route)) {
        route.environment = getEnvironmentId();
        route.session = "";
        route.job = "";
      }
      await applyRoute(route, { initial: true });
    } catch (error) {
      shell.showToast(
        error instanceof Error ? error.message : String(error),
        "failed",
      );
    } finally {
      applying = false;
      ready = true;
      replaceCurrentUrl();
    }
    const pending = pendingInitialHistory;
    pendingInitialHistory = null;
    if (pending) await restoreHistory(pending.route, pending.targetIndex);
  }

  function restoreHistoryUrl(targetIndex) {
    if (canReturnToAcceptedHistoryEntry(targetIndex, historyIndex)) {
      viewport.history.go(historyIndex - targetIndex);
      return;
    }
    replaceCurrentUrl();
  }

  async function restoreHistory(route, targetIndex) {
    if (workspaceRouteUrl(route) === acceptedUrl) {
      if (Number.isInteger(targetIndex)) historyIndex = targetIndex;
      return;
    }
    applying = true;
    let accepted = false;
    try {
      accepted = await applyRoute(route);
    } catch (error) {
      shell.showToast(
        error instanceof Error ? error.message : String(error),
        "failed",
      );
    } finally {
      applying = false;
    }
    if (isEnvironmentChanging()) return;
    if (!accepted) {
      const unchanged = workspaceRouteUrl(currentRoute()) === acceptedUrl;
      if (unchanged) {
        restoreHistoryUrl(targetIndex);
        return;
      }
    }
    if (Number.isInteger(targetIndex)) historyIndex = targetIndex;
    replaceCurrentUrl();
  }

  function bind() {
    if (bound) return;
    bound = true;
    viewport.addEventListener("popstate", (event) => {
      const route = readWorkspaceRoute(viewport.location);
      const targetIndex = event.state?.abotWorkspaceIndex;
      if (!ready) {
        initialRoute = route;
        pendingInitialHistory = { route, targetIndex };
        return;
      }
      restoreQueue = restoreQueue.then(() =>
        restoreHistory(route, targetIndex),
      );
    });
  }

  return { bind, bootstrapEnvironment, restoreInitial, sync };
}

function canReturnToAcceptedHistoryEntry(targetIndex, currentIndex) {
  if (!Number.isInteger(targetIndex)) return false;
  return targetIndex !== currentIndex;
}

function routeCarriesConversation(route) {
  if (route.workspace !== "chat") return false;
  return Boolean(route.session);
}

function existingWorkspaceHistoryIndex(state) {
  if (!Number.isInteger(state?.abotWorkspaceIndex)) return 0;
  return state.abotWorkspaceIndex;
}

function routeChangesEnvironment(route, selectedEnvironment) {
  if (!route.environment) return false;
  return route.environment !== selectedEnvironment;
}

function routeSessionIsListed(route, sessions) {
  return sessions.some((session) => session.id === route.session);
}

function initialRouteWasSuperseded(initial, pendingHistory) {
  if (!initial) return false;
  return Boolean(pendingHistory);
}
