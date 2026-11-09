import { sparkHomeRunFailureMessage } from "../lib/spark-home-run-feedback.js";

function hasSameSparkHomeScreen(left, right) {
  if (!left || !right) return left === right;
  return left.revision === right.revision && left.updatedAt === right.updatedAt;
}
function sparkHomeViewMode(mode) { return mode === "spark_home" ? "spark" : "dashboard"; }

/** HOME preferences and committed screen metadata are independent of conversation state. */
export function createSparkHomeController({ client, getEnvironmentId, isAvailable, render, onModeChange,
  requestScreen, confirmRequest = async () => false }) {
  const state = { environmentId: getEnvironmentId(), mode: "dashboard", available: false, configured: false,
    configurationKnown: false, configurationLoading: false, reason: null, settingsRevision: null,
    screen: null, loading: false, saving: false, requesting: false, generationPhase: "", generationNotice: "",
    error: "", preferenceError: "" };
  let active = false;
  let generation = 0;
  let preferencesRevision = null;
  let confirming = false;
  let modeRevision = 0;
  const publish = () => render({ ...state });
  function ownsRead(environment, revision) {
    if (environment !== state.environmentId || environment !== getEnvironmentId()) return false;
    return revision === generation;
  }
  async function refresh() {
    if (!isAvailable() || !state.environmentId) {
      state.available = false; state.loading = false; publish(); return;
    }
    const environment = state.environmentId;
    const revision = ++generation;
    const selectedMode = modeRevision;
    state.loading = active && state.mode === "spark"; state.configurationLoading = !state.configurationKnown;
    state.error = ""; publish();
    const [settings, preferences, screen] = await Promise.allSettled([
      client.getSparkHomeSettings(environment), client.getSparkHomePreferences(environment), client.getSparkHome(environment),
    ]);
    if (!ownsRead(environment, revision)) return;
    state.loading = false; state.configurationLoading = false;
    if (settings.status === "fulfilled") {
      state.configurationKnown = true;
      state.configured = settings.value.settings.available === true;
      state.available = state.configured;
      state.reason = settings.value.settings.reason;
      state.settingsRevision = settings.value.settings.revision;
    } else { state.available = false; state.error = "HOME settings could not be loaded."; }
    if (preferences.status === "fulfilled" && selectedMode === modeRevision) {
      preferencesRevision = preferences.value.preferences.revision;
      state.mode = sparkHomeViewMode(preferences.value.preferences.mode);
      onModeChange(state.mode);
    }
    if (screen.status === "fulfilled") {
      if (!hasSameSparkHomeScreen(state.screen, screen.value.screen)) {
        state.screen = screen.value.screen; state.generationNotice = "";
      }
    } else state.error = "Your HOME screen could not be loaded. Try loading again.";
    if (state.generationPhase === "finishing") state.generationPhase = "";
    publish();
  }
  async function selectMode(mode) {
    if (!["dashboard", "spark"].includes(mode) || state.saving) return;
    if (mode === state.mode) return;
    const selectedEnvironment = state.environmentId;
    if (preferencesRevision === null) await refresh();
    if (selectedEnvironment !== getEnvironmentId()) return;
    if (preferencesRevision === null) { state.preferenceError = "Home view preferences could not be loaded."; publish(); return; }
    const environment = state.environmentId;
    const revision = ++modeRevision;
    state.mode = mode; state.saving = true; state.preferenceError = "";
    onModeChange(mode); publish();
    try {
      const result = await client.configureSparkHomePreferences({ expectedRevision: preferencesRevision,
        mode: mode === "spark" ? "spark_home" : "dashboard" }, environment);
      if (environment !== getEnvironmentId() || revision !== modeRevision) return;
      preferencesRevision = result.preferences.revision;
    } catch {
      if (environment === getEnvironmentId() && revision === modeRevision)
        state.preferenceError = "This view could not be saved for your next visit. Reload HOME before trying again.";
    } finally {
      if (environment === getEnvironmentId() && revision === modeRevision) { state.saving = false; publish(); }
    }
  }
  async function requestNewScreen({ confirmed = false } = {}) {
    if (!active || state.mode !== "spark" || !isAvailable()) return false;
    if (!state.available || state.requesting || state.generationPhase || confirming) return false;
    const environment = state.environmentId;
    const selectedMode = modeRevision;
    confirming = true;
    try {
      if (!confirmed && await confirmRequest() !== true) return false;
      if (environment !== getEnvironmentId() || selectedMode !== modeRevision || !state.available || !isAvailable()) return false;
      state.requesting = true; state.generationNotice = ""; publish();
      return await requestScreen(state.settingsRevision);
    } finally {
      if (environment === getEnvironmentId()) { confirming = false; state.requesting = false; publish(); }
    }
  }
  return {
    state: () => ({ ...state }), refresh, selectMode, requestNewScreen,
    setActive(value) { const entered = value && !active; active = value; if (entered) return refresh(); },
    setRun({ run, connected, error }) {
      if (run?.status === "awaiting_approval") state.generationPhase = "approval";
      else if (run?.status === "running") state.generationPhase = connected ? "working" : "reconnecting";
      else if (run?.status === "completed" && state.loading && run.screenRevision !== state.screen?.revision) state.generationPhase = "finishing";
      else state.generationPhase = "";
      if (["failed", "cancelled", "interrupted"].includes(run?.status))
        state.generationNotice = sparkHomeRunFailureMessage(run) || "HOME did not finish creating a screen. Open SPARK for details.";
      else if (error) state.generationNotice = error;
      publish();
    },
    environmentChanged() {
      if (state.environmentId === getEnvironmentId()) return refresh();
      generation += 1; modeRevision += 1; preferencesRevision = null; confirming = false;
      Object.assign(state, { environmentId: getEnvironmentId(), mode: "dashboard", screen: null, available: false,
        configured: false, configurationKnown: false, configurationLoading: false, settingsRevision: null,
        loading: false, saving: false, requesting: false, generationPhase: "", generationNotice: "", error: "", preferenceError: "" });
      onModeChange(state.mode); publish(); return refresh();
    },
    contentError() { state.screen = null; state.error = "Screen could not be loaded. Try loading again."; publish(); },
  };
}
