const emptyAnswers = () => ({ widgetIds: [], topics: "", constraints: "", personalInstructions: "" });

function calibrationErrorMessage(error, fallback) {
  const messages = {
    spark_home_settings_conflict: "HOME settings changed. Close this window and reload the saved settings before continuing.",
    spark_home_calibration_options_changed: "The available HOME choices changed. Close and reopen this window to review them.",
    spark_home_calibration_busy: "A HOME instruction draft is already being created. Wait for it to finish before trying again.",
    spark_home_calibration_unavailable: "Set up an available HOME or SPARK model before asking for a draft.",
    spark_home_model_unavailable: "The selected HOME model is unavailable. You can write instructions yourself or choose another model.",
    spark_home_model_required: "Choose an EA model in HOME settings before asking for an instruction draft.",
    spark_home_execution_agent_required: "Choose an EA model for HOME. Your answers are kept.",
    spark_home_calibration_timeout: "The draft took too long. Your answers are kept; try again or write the instructions yourself.",
    spark_home_calibration_output_invalid: "The model did not return a usable draft. Your answers are kept; try again or write the instructions yourself.",
  };
  return messages[error?.code || error?.message] || error?.message || fallback;
}

function hasCalibrationAnswers(answers) {
  if (answers.widgetIds.length) return true;
  if (answers.topics.trim()) return true;
  return Boolean(answers.constraints.trim());
}

function canUseCalibrationSettings(settings) {
  if (!settings.ready || settings.loading || settings.saving) return false;
  if (settings.conflict || settings.reloadRequired || settings.error) return false;
  return Number.isSafeInteger(settings.revision);
}

/** Request-local form state. Only an explicit save updates the existing HOME settings owner. */
export function createSparkHomeCalibrationController({ client, settings, getEnvironmentId, render, onSaved, onRequest }) {
  const state = { open: false, environmentId: getEnvironmentId(), mode: "guided", answers: emptyAnswers(),
    options: [], loading: false, drafting: false, saving: false, error: "", preview: false };
  let generation = 0;
  let binding = null;
  let lastSettingsInstructions = null;
  let checkingRequest = false;
  const snapshot = () => ({ ...state, answers: { ...state.answers, widgetIds: [...state.answers.widgetIds] } });
  const publish = () => render(snapshot());
  const isCalibrationBusy = () => state.loading || state.drafting || state.saving;
  function ownsCalibrationOperation(environment, revision) {
    if (environment !== getEnvironmentId() || environment !== state.environmentId) return false;
    return state.open && revision === generation;
  }
  function hasCurrentCalibrationBinding() {
    const current = settings.snapshot();
    if (!binding || !canUseCalibrationSettings(current)) return false;
    if (binding.expectedRevision !== current.revision) return false;
    return binding.modelProfileId === (current.values.modelProfileId || null);
  }
  function settingsFailure() {
    return settings.snapshot().error || "HOME settings could not be loaded. Close this window and reload the HOME settings before trying again.";
  }
  async function open() {
    if (state.open) return;
    const environment = getEnvironmentId();
    if (environment !== state.environmentId) environmentChanged();
    const revision = ++generation;
    state.open = true; state.loading = true; state.error = ""; binding = null; publish();
    try {
      await settings.loadForCalibration();
      if (!ownsCalibrationOperation(environment, revision)) return;
      const current = settings.snapshot();
      if (!canUseCalibrationSettings(current)) throw new Error(settingsFailure());
      if (current.values.personalInstructions !== lastSettingsInstructions) state.answers.personalInstructions = current.values.personalInstructions;
      lastSettingsInstructions = current.values.personalInstructions;
      state.preview = Boolean(state.answers.personalInstructions);
      binding = { expectedRevision: current.revision, modelProfileId: current.values.modelProfileId || null };
      const result = await client.getSparkHomeCalibrationOptions(binding, environment);
      if (!ownsCalibrationOperation(environment, revision)) return;
      state.options = result.calibration.options;
    } catch (error) {
      if (ownsCalibrationOperation(environment, revision)) state.error = calibrationErrorMessage(error, "HOME choices could not be loaded. You can still write your own instructions.");
    } finally {
      if (ownsCalibrationOperation(environment, revision)) { state.loading = false; publish(); }
    }
  }
  function change(name, value) {
    if (!state.open || isCalibrationBusy()) return;
    if (name === "mode") {
      state.mode = value === "manual" ? "manual" : "guided";
    } else if (name === "widgetIds") {
      state.answers.widgetIds = value.filter((id) => state.options.some((option) => option.id === id && (option.available || state.answers.widgetIds.includes(id))));
    } else if (Object.hasOwn(state.answers, name)) state.answers[name] = String(value);
    state.error = ""; publish();
  }
  async function draft() {
    if (!state.open || isCalibrationBusy()) return false;
    if (!hasCurrentCalibrationBinding()) { state.error = settingsFailure(); publish(); return false; }
    if (!hasCalibrationAnswers(state.answers)) {
      state.error = "Choose something useful for HOME or describe what matters to you first."; publish(); return false;
    }
    if (state.answers.widgetIds.some((id) => !state.options.some((option) => option.id === id && option.available))) {
      state.error = "Remove the selected choices that are no longer available before drafting."; publish(); return false;
    }
    const environment = state.environmentId;
    const revision = ++generation;
    state.drafting = true; state.error = ""; publish();
    try {
      const { widgetIds, topics, constraints } = state.answers;
      const result = await client.draftSparkHomeInstructions({ ...binding, widgetIds, topics, constraints }, environment);
      if (!ownsCalibrationOperation(environment, revision)) return false;
      if (!hasCurrentCalibrationBinding()) throw new Error("HOME settings changed. Close this window and reload them before continuing.");
      state.answers.personalInstructions = result.draft.personalInstructions;
      state.preview = true;
      return true;
    } catch (error) {
      if (ownsCalibrationOperation(environment, revision)) state.error = calibrationErrorMessage(error, "The draft could not be created. Your answers are kept; you can retry or write the instructions yourself.");
      return false;
    } finally {
      if (ownsCalibrationOperation(environment, revision)) { state.drafting = false; publish(); }
    }
  }
  async function save(requestScreen = false) {
    if (!state.open || isCalibrationBusy()) return false;
    const instructions = state.answers.personalInstructions.trim();
    if (!instructions || instructions.length > 4000) {
      state.error = "Write a direction for HOME within 4,000 characters before saving."; publish(); return false;
    }
    if (!hasCurrentCalibrationBinding()) { state.error = settingsFailure(); publish(); return false; }
    const environment = state.environmentId;
    const revision = ++generation;
    state.saving = true; state.error = ""; publish();
    settings.change("personalInstructions", instructions);
    const saved = settings.snapshot().changed ? await settings.save() : true;
    if (!ownsCalibrationOperation(environment, revision)) return false;
    state.saving = false;
    if (!saved) { state.error = settingsFailure(); publish(); return false; }
    lastSettingsInstructions = settings.snapshot().values.personalInstructions;
    close();
    await onSaved({ requestScreen, environmentId: environment });
    return true;
  }
  function close() {
    if (state.saving) return;
    generation += 1;
    state.open = false; state.loading = false; state.drafting = false;
    publish();
  }
  function environmentChanged() {
    if (getEnvironmentId() === state.environmentId) return;
    generation += 1; binding = null; checkingRequest = false; lastSettingsInstructions = null;
    Object.assign(state, { open: false, environmentId: getEnvironmentId(), mode: "guided", answers: emptyAnswers(),
      options: [], loading: false, drafting: false, saving: false, error: "", preview: false });
    publish();
  }
  async function requestScreen() {
    if (checkingRequest || state.open) return false;
    const environment = getEnvironmentId();
    checkingRequest = true;
    try {
      await settings.loadForCalibration();
      if (environment !== getEnvironmentId()) return false;
      const current = settings.snapshot();
      if (!canUseCalibrationSettings(current) || current.calibrationRequired) { await open(); return false; }
      return await onRequest();
    } finally { checkingRequest = false; }
  }
  publish();
  return { snapshot, open, close, change, draft, save, environmentChanged, requestScreen };
}
