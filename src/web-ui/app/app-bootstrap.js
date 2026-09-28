import { createStartupScreen } from "./components/startup-screen.js";
import { createWorkspaceRouteController } from "./controllers/workspace-route-controller.js";
import { textOf } from "./lib/text-format.js";

export async function bootstrapWebApp({
  state,
  dom,
  preferences,
  shell,
  homeComposer,
  dashboard,
  learning,
  notifications,
  schedules,
  projects,
  selection,
  client,
  bindables,
  bindEvents,
  renderComposer,
  renderMessages,
  operations,
  configuration,
  realtime,
  restoreLastSession,
  navigation,
  onNavigationReady = () => {},
}) {
  const routes = navigation
    ? createWorkspaceRouteController({
        shell,
        configuration,
        selection,
        schedules,
        getEnvironmentId: () => dom.environmentSelect.value,
        getSessionId: () => state.currentSessionId,
        changeEnvironment: navigation.bindings.changeEnvironment,
        isEnvironmentChanging: navigation.bindings.isEnvironmentChanging,
        loadSessions: navigation.conversation.loadSessions,
        openSession: navigation.conversation.openSession,
        restoreLastSession,
      })
    : null;
  onNavigationReady(routes);
  routes?.bind();
  selection.loadPreferences();
  shell.load();
  homeComposer.setWorkspace(shell.activeWorkspace());
  dashboard.setActive(true);
  for (const control of [shell, ...bindables]) control.bind();
  bindEvents();
  renderComposer();
  selection.renderPermissionMode();
  renderMessages();
  state.config = await client.loadWebConfig();
  void configuration.refreshComputerAccess?.();
  schedules.refreshAvailability();
  notifications?.refreshAvailability();
  projects?.refreshAvailability();
  selection.renderEnvironmentOptions();
  const options = selection.environmentOptions();
  const saved = preferences.environmentId();
  const fallback =
    textOf(state.config.defaultEnvironmentId).trim() || options[0]?.value || "";
  const hasSavedEnvironment = options.some((option) => option.value === saved);
  dom.environmentSelect.value = routes
    ? routes.bootstrapEnvironment(options, saved, fallback)
    : hasSavedEnvironment
      ? saved
      : fallback;
  preferences.saveEnvironmentId(dom.environmentSelect.value);
  learning?.environmentChanged();
  learning?.setWorkspace(shell.activeWorkspace());
  homeComposer.environmentChanged();
  selection.renderAgentPicker();
  realtime.connect();
  await Promise.allSettled([
    projects?.load(),
    selection.loadModels(),
    selection.loadAgentMode(),
    operations.loadRuntimeStatus(),
    operations.loadSystemHealth(),
    configuration.load(),
  ]);
  if (routes) await routes.restoreInitial();
  else await restoreLastSession();
  dashboard.setReady();
  notifications?.setReady();
}

export async function startWebApp(options) {
  const startup = createStartupScreen();
  try {
    await bootstrapWebApp(options);
    startup.ready();
  } catch (error) {
    startup.fail(error);
  }
}
