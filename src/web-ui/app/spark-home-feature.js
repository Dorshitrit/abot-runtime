import { createSparkHomeController } from "./controllers/spark-home-controller.js";
import { createSparkHomeRunController } from "./controllers/spark-home-run-controller.js";
import { createSparkHomeWorkspace } from "./components/spark-home/workspace.js";
import { createSparkHomeRunActivity } from "./components/spark-home/run-activity.js";
import { createSparkHomeSettingsController } from "./controllers/spark-home-settings-controller.js";
import { createSparkHomeSettingsView } from "./components/spark-home/settings-view.js";
import { createSparkHomeCalibrationFeature } from "./spark-home-calibration-feature.js";
import { selectLearningView } from "./components/passive-learning/workspace-view.js";
import { confirmDialog } from "./components/confirmation-dialog.js";
import { createSystemWidgets } from "./components/system-widgets/host.js";

/** Optional HOME surface and service clients; the ordinary SPARK composer is untouched. */
export function createSparkHomeFeature({ dom, dashboard, spark, client, shell, realtime, getEnvironmentId,
  documentRoot = document }) {
  let home; let runs; let calibration; let settings;
  const canAccessHome = () => client.supportsSparkChat?.() === true && shell.isWorkspaceAvailable("learning");
  const widgets = createSystemWidgets({ client, getEnvironmentId, isAvailable: canAccessHome, documentRoot,
    dashboardWidgets: dashboard.compactWidgets,
    onConfigureSpark: async () => {
      const environment = getEnvironmentId();
      const activate = await shell.prepareWorkspaceActivation("learning");
      if (!activate || environment !== getEnvironmentId() || !activate()) return;
      selectLearningView(dom.learningRoot, "settings", true);
    } });
  async function selectMode(mode) {
    if (mode === "dashboard") {
      const prepared = await widgets.prepareLeave();
      if (prepared === false || prepared === null || prepared?.canCommit?.() === false) return;
      if (typeof prepared === "function" && prepared() === false) return;
    }
    return home.selectMode(mode);
  }
  async function openHomeSettings() {
    const environment = getEnvironmentId();
    const activate = await shell.prepareWorkspaceActivation("learning");
    if (!activate || environment !== getEnvironmentId() || !activate()) return;
    selectLearningView(dom.learningRoot, "home", true); settings.setActive(true);
  }
  function setup() {
    if (["spark_chat_model_required", "spark_chat_model_unavailable"].includes(home.state().reason))
      return spark.openModelSettings();
    return openHomeSettings();
  }
  const view = createSparkHomeWorkspace({ root: dom.homeWorkspacePanel, dashboardRoot: dom.homeDashboardRoot,
    contentUrl: client.sparkHomeContentUrl, documentRoot, widgets,
    onMode: mode => void selectMode(mode), onRequest: () => void calibration.requestScreen(),
    onTalk: () => void spark.open(), onSetup: setup, onRetry: () => void home.refresh(),
    onContentError: () => home.contentError(),
  });
  home = createSparkHomeController({ client, getEnvironmentId, isAvailable: canAccessHome,
    render: state => view.render({ ...state, workspaceActive: shell.activeWorkspace() === "home" }),
    onModeChange(mode) {
      if (mode === "spark") dashboard.compactWidgets.close({ restoreFocus: false });
      runs?.setWatching((shell.activeWorkspace() === "home" && mode === "spark") || spark.isOpen());
    },
    requestScreen: revision => runs.start(revision),
    confirmRequest: () => confirmDialog("This asks SPARK to create or redesign your HOME. You can stay here while it works, or open SPARK to approve or stop it.",
      { title: "Request a new HOME screen?", confirmLabel: "Send request" }),
  });
  const activity = createSparkHomeRunActivity({ root: spark.homeActivityRoot,
    onDecision: (...args) => void runs.decide(...args), onCancel: () => void runs.cancel() });
  runs = createSparkHomeRunController({ client, getEnvironmentId, isAvailable: canAccessHome,
    render(state) { home.setRun(state); activity.render(state); }, onPublished: () => void home.refresh() });
  const settingsView = createSparkHomeSettingsView({ root: dom.learningRoot,
    onChange: (name, value) => settings.change(name, value), onSave: () => settings.save(),
    onReload: () => settings.reload(), onCalibrate: () => calibration.open() });
  settings = createSparkHomeSettingsController({ client, getEnvironmentId, canUseSettings: canAccessHome,
    render: settingsView.render, focus: settingsView.focus, onSaved: () => void home.refresh() });
  calibration = createSparkHomeCalibrationFeature({ client, settings, home, shell, getEnvironmentId,
    documentRoot: dom.homeWorkspacePanel.ownerDocument || documentRoot });
  function workspaceChanged() {
    const active = shell.activeWorkspace() === "home";
    home.setActive(active); runs.setWatching((active && home.state().mode === "spark") || spark.isOpen());
    widgets.setActive(active && home.state().mode === "spark" && !home.state().generationPhase);
    const panel = dom.learningRoot?.querySelector('[data-learning-panel="home"]');
    settings.setActive(shell.activeWorkspace() === "learning" && panel?.hidden === false);
  }
  function environmentChanged() {
    calibration.environmentChanged();
    widgets.environmentChanged();
    return Promise.all([home.environmentChanged(), runs.environmentChanged(), settings.environmentChanged()]);
  }
  dom.homeWorkspaceButton.addEventListener("click", () => {
    if (shell.activeWorkspace() === "home") void selectMode("dashboard");
  });
  shell.addWorkspaceGuard?.(({ from, to }) => from === "home" && to !== "home" ? widgets.prepareLeave() : true);
  shell.subscribeWorkspaceChange(workspaceChanged);
  shell.subscribeRuntimeAvailabilityChange(() => void environmentChanged());
  dom.environmentSelect.addEventListener("change", () => queueMicrotask(() => void environmentChanged()));
  dom.learningRoot?.addEventListener("click", workspaceChanged);
  dom.learningRoot?.addEventListener("keydown", workspaceChanged);
  realtime.subscribeConnected(() => { widgets.reconnect(); void environmentChanged(); });
  realtime.subscribeMessages(message => {
    widgets.handleRealtime(message);
    if (message.type !== "spark_home_changed" || message.environmentId !== getEnvironmentId()) return;
    void runs.refresh(); void home.refresh();
  });
  documentRoot.addEventListener("visibilitychange", () => {
    widgets.visibilityChanged();
    if (documentRoot.visibilityState === "visible") { void home.refresh(); void runs.refresh(); }
  });
  documentRoot.defaultView?.addEventListener("beforeunload", event => {
    if (!widgets.isDirty() && !widgets.isBusy()) return;
    event.preventDefault(); event.returnValue = "";
  });
  workspaceChanged();
  return { environmentChanged, refresh: home.refresh, prepareEnvironmentChange: widgets.prepareLeave };
}
