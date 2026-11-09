const defaults = () => ({ personalInstructions: "", modelProfileId: "" });
const conflictMessage = "HOME settings changed elsewhere. Your edits are kept here; reload saved settings before editing again.";

function projectSaveFailure(error) {
  const code = error?.code || error?.message;
  if (code === "spark_home_settings_conflict")
    return { conflict: true, reloadRequired: true, error: conflictMessage };
  if (code === "spark_home_calibration_required")
    return { conflict: false, reloadRequired: false, error: "Add a personal direction for HOME before requesting a screen. Nothing was saved." };
  if (["spark_home_model_required", "spark_home_model_unavailable", "spark_home_execution_agent_required"].includes(code))
    return { conflict: false, reloadRequired: false, error: "Choose an available EA model for HOME. Nothing was saved." };
  return { conflict: false, reloadRequired: true,
    error: "The save could not be confirmed. Some settings may have been saved. Your edits are kept here; reload saved settings before retrying." };
}

function editableValues(settings) {
  return { personalInstructions: settings.personalInstructions, modelProfileId: settings.modelProfileId || "" };
}

/** HOME settings have their own lifecycle; learning and chat drafts are not involved. */
export function createSparkHomeSettingsController({ client, getEnvironmentId, canUseSettings, render, focus = () => {}, onSaved = () => {} }) {
  let active = false;
  let generation = 0;
  let saved = null;
  const state = { environmentId: getEnvironmentId(), values: defaults(), models: [], modelsLoaded: false,
    ready: false, loading: false, saving: false, conflict: false, reloadRequired: false, error: "", feedback: "", modelsError: "" };
  const changed = () => saved !== null && JSON.stringify(state.values) !== JSON.stringify(editableValues(saved));
  const snapshot = () => ({ ...state, values: { ...state.values }, changed: changed(),
    revision: saved?.revision, available: saved?.available === true, reason: saved?.reason || null,
    calibrationRequired: saved?.calibrationRequired ?? !saved?.personalInstructions?.trim() });
  const publish = () => render(snapshot());
  const owns = (environment, revision) => environment === state.environmentId && environment === getEnvironmentId() && revision === generation;

  function acceptSettings(settings) {
    saved = settings;
    state.values = editableValues(settings);
    state.ready = true;
    state.conflict = false;
    state.reloadRequired = false;
    state.error = "";
    state.models = settings.models || []; state.modelsLoaded = true; state.modelsError = "";
  }

  async function refresh({ discardDraft = false, forCalibration = false } = {}) {
    if (!active && !forCalibration) return;
    if (state.saving) return;
    if (!canUseSettings() || !state.environmentId) {
      state.ready = false;
      state.error = "HOME settings are available when the runtime is connected.";
      publish(); return;
    }
    const environment = state.environmentId;
    const revision = ++generation;
    state.loading = true;
    if (!state.conflict && !state.reloadRequired) state.error = "";
    state.feedback = ""; publish();
    const [settingsRead] = await Promise.allSettled([client.getSparkHomeSettings(environment)]);
    if (!owns(environment, revision)) return;
    state.loading = false;
    if (settingsRead.status === "fulfilled") {
      const settings = settingsRead.value.settings;
      state.models = settings.models || []; state.modelsLoaded = true;
      if (!saved || discardDraft || (!changed() && !state.reloadRequired)) acceptSettings(settings);
      else if (!state.reloadRequired && settings.revision !== saved.revision) {
        state.conflict = true;
        state.error = conflictMessage;
      }
    } else state.error = settingsRead.reason?.message || "HOME settings could not be loaded.";
    publish();
  }

  function change(name, value) {
    if (!Object.hasOwn(state.values, name) || !state.ready || state.loading || state.saving) return;
    state.values[name] = String(value);
    state.feedback = "";
    if (!state.conflict && !state.reloadRequired) state.error = "";
    publish();
  }

  function invalid(name, message) {
    state.error = message; publish(); focus(name); return false;
  }

  async function save() {
    if (!saved || !state.ready || state.loading || state.saving || state.conflict || state.reloadRequired || !changed()) return false;
    if (!canUseSettings() || state.environmentId !== getEnvironmentId()) return false;
    const values = state.values;
    if (values.personalInstructions.length > 4000) return invalid("personalInstructions", "Keep personal instructions within 4,000 characters.");
    if (values.modelProfileId && state.modelsLoaded && !state.models.some((model) => model.id === values.modelProfileId))
      return invalid("modelProfileId", "Choose an available EA model for HOME.");
    const environment = state.environmentId;
    const revision = ++generation;
    state.saving = true; state.error = ""; state.feedback = ""; publish();
    try {
      const result = await client.configureSparkHomeSettings({ expectedRevision: saved.revision,
        personalInstructions: values.personalInstructions, modelProfileId: values.modelProfileId || null }, environment);
      if (!owns(environment, revision)) return false;
      acceptSettings(result.settings); state.feedback = "HOME settings saved.";
      onSaved(result.settings);
      return true;
    } catch (error) {
      if (!owns(environment, revision)) return false;
      Object.assign(state, projectSaveFailure(error));
      return false;
    } finally {
      if (owns(environment, revision)) { state.saving = false; publish(); }
    }
  }

  function environmentChanged() {
    const environment = getEnvironmentId();
    if (environment === state.environmentId) return refresh();
    generation += 1; saved = null;
    Object.assign(state, { environmentId: environment, values: defaults(), models: [], modelsLoaded: false,
      ready: false, loading: false, saving: false, conflict: false, reloadRequired: false, error: "", feedback: "", modelsError: "" });
    publish(); return refresh();
  }
  publish();
  return { snapshot, change, save, refresh, environmentChanged,
    loadForCalibration: () => refresh({ forCalibration: true }),
    reload: () => refresh({ discardDraft: true }),
    setActive(value) {
      const entered = value && !active;
      active = value;
      if (entered) return refresh();
    },
  };
}
