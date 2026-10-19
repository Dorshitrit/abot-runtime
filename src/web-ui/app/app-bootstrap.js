import { createStartupScreen } from "./components/startup-screen.js";
import { createWorkspaceRouteController } from "./controllers/workspace-route-controller.js";
import { textOf } from "./lib/text-format.js";
import { createAutomationsFeature } from "./automations-feature.js";
import { createSparkChatFeature } from "./spark-chat-feature.js";
import { canRestoreSparkAddress, sparkNotificationReference } from "./lib/spark-chat-address.js";
import { createSparkHandoffNavigation } from "./controllers/spark-handoff-navigation.js";

export async function bootstrapWebApp({
  state,
  dom,
  preferences,
  shell,
  homeComposer,
  dashboard,
  learning,
  notifications,
  skills,
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
  let routes = null;
  const initialAddress = new URL(window.location.href);
  const spark = createSparkChatFeature({ dom, state, client, shell, realtime, getEnvironmentId: () => dom.environmentSelect.value,
    captureHandoffNavigation: createSparkHandoffNavigation({ state, getEnvironmentId: () => dom.environmentSelect.value,
      shell, conversation: navigation?.conversation, onNavigationChange: () => routes?.sync() }),
    onOpenSchedule: (jobId) => schedules.openJob(jobId) });
  navigation?.bindings.setEnvironmentChangePreparation(spark.prepareEnvironmentChange, spark.refreshComposerSubmissionState);
  notifications?.setCompanionChat?.(spark);
  const automations = createAutomationsFeature({
    dom, client, shell, realtime,
    getEnvironmentId: () => dom.environmentSelect.value,
    onNavigationChange: () => routes?.sync(),
  });
  routes = navigation
    ? createWorkspaceRouteController({
        shell,
        configuration,
        selection,
        schedules,
        automations,
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
  let preferenceViewsReady = false;
  function synchronizePreferences() {
    selection.loadPreferences();
    if (!preferenceViewsReady) return;
    selection.applyModelSelection();
    selection.renderPermissionMode();
    void dashboard.refresh();
    void navigation?.conversation.loadSessions();
  }
  preferences.subscribe?.(synchronizePreferences);
  selection.loadPreferences();
  shell.load();
  homeComposer.setWorkspace(shell.activeWorkspace());
  dashboard.setActive(true);
  for (const control of [shell, ...bindables, spark]) control.bind();
  bindEvents();
  skills?.bind();
  renderComposer();
  selection.renderPermissionMode();
  renderMessages();
  state.config = await client.loadWebConfig();
  void configuration.refreshComputerAccess?.();
  schedules.refreshAvailability();
  automations.refreshAvailability();
  notifications?.refreshAvailability();
  skills?.refreshAvailability();
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
  navigation?.bindings.initializeEnvironment?.();
  learning?.environmentChanged();
  spark.environmentChanged();
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
  if (canRestoreSparkAddress(initialAddress, dom.environmentSelect.value))
    await spark.open(initialAddress.searchParams.get("message") || undefined, sparkNotificationReference(initialAddress));
  dashboard.setReady();
  notifications?.setReady();
  preferenceViewsReady = true;
  synchronizePreferences();
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
