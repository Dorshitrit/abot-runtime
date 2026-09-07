import { textOf } from "./lib/text-format.js";

export async function bootstrapWebApp({
  state,
  dom,
  preferences,
  shell,
  homeComposer,
  dashboard,
  schedules,
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
}) {
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
  schedules.refreshAvailability();
  selection.renderEnvironmentOptions();
  const options = selection.environmentOptions();
  const saved = preferences.environmentId();
  const fallback =
    textOf(state.config.defaultEnvironmentId).trim() || options[0]?.value || "";
  const hasSavedEnvironment = options.some((option) => option.value === saved);
  dom.environmentSelect.value = hasSavedEnvironment ? saved : fallback;
  preferences.saveEnvironmentId(dom.environmentSelect.value);
  homeComposer.environmentChanged();
  selection.renderAgentPicker();
  realtime.connect();
  await Promise.allSettled([
    selection.loadModels(),
    selection.loadAgentMode(),
    operations.loadRuntimeStatus(),
    operations.loadSystemHealth(),
    configuration.load(),
  ]);
  await restoreLastSession();
  dashboard.setReady();
}
