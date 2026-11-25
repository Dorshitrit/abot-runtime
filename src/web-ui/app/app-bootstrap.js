import { createStartupScreen } from "./components/startup-screen.js";
import { createWorkspaceRouteController } from "./controllers/workspace-route-controller.js";
import { createPreferenceViewSync } from "./controllers/preference-view-sync.js";
import { textOf } from "./lib/text-format.js";
import { createAgentsFeature } from "./agents-feature.js";
import { createAutomationsFeature } from "./automations-feature.js";
import { createSparkChatFeature } from "./spark-chat-feature.js";
import { createSparkHomeFeature } from "./spark-home-feature.js";
import { canRestoreSparkAddress, sparkNotificationReference } from "./lib/spark-chat-address.js";
import { createSparkHandoffNavigation } from "./controllers/spark-handoff-navigation.js";
import { prepareSystemWidgetEnvironmentChange } from "./components/system-widgets/management-leave.js";

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
  informationBasket,
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
  const sparkHome = createSparkHomeFeature({ dom, dashboard, spark, client, shell, realtime,
    getEnvironmentId: () => dom.environmentSelect.value });
  navigation?.bindings.setEnvironmentChangePreparation(
    () => prepareSystemWidgetEnvironmentChange(spark.prepareEnvironmentChange, sparkHome.prepareEnvironmentChange),
    spark.refreshComposerSubmissionState);
  notifications?.setCompanionChat?.(spark);
  operations.setCompanionResetHandler?.(spark.sessionsReset);
  const automations = createAutomationsFeature({
    dom, client, shell, realtime,
    startNewConversation: (options) => navigation?.bindings.newConversation(options) ?? Promise.resolve(false),
    getEnvironmentId: () => dom.environmentSelect.value,
    onNavigationChange: () => routes?.sync(),
  });
  const agents = createAgentsFeature({ dom, client, shell, getEnvironmentId: () => dom.environmentSelect.value,
    onNavigationChange: () => { routes?.sync(); notifications?.presenceChanged?.(); } });
  notifications?.setAgents?.(agents);
  routes = navigation
    ? createWorkspaceRouteController({
        shell,
        configuration,
        selection,
        schedules,
        automations,
        agents,
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
  const preferenceViews = createPreferenceViewSync({
    preferences, selection, dashboard,
    getEnvironmentId: () => dom.environmentSelect.value,
    loadSessions: () => navigation?.conversation.loadSessions(),
  });
  preferences.subscribe?.(preferenceViews.synchronize);
  selection.loadPreferences();
  shell.load();
  homeComposer.setWorkspace(shell.activeWorkspace());
  dashboard.setActive(true);
  for (const control of [shell, ...bindables, spark]) control.bind();
  bindEvents();
  skills?.bind();
  informationBasket?.bind();
  renderComposer();
  selection.renderPermissionMode();
  renderMessages();
  state.config = await client.loadWebConfig();
  void configuration.refreshComputerAccess?.();
  schedules.refreshAvailability();
  automations.refreshAvailability();
  agents.refreshAvailability();
  notifications?.refreshAvailability();
  skills?.refreshAvailability();
  informationBasket?.refreshAvailability();
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
  void agents.environmentChanged();
  sparkHome.environmentChanged();
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
  preferenceViews.setReady();
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
