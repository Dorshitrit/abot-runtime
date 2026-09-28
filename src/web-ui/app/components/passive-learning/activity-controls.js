const activities = Object.freeze({
  collection: { label: "collection", permissionField: "collectionEnabled", selector: "[data-learning-toggle]" },
  learning: { label: "learning", permissionField: "processingEnabled", selector: "[data-learning-processing-toggle]" },
  proactive: { label: "proactive mode", permissionField: "proactiveEnabled", selector: "[data-learning-proactive-toggle]" },
});

export function readActivityPermissions(preferences = {}) {
  if (preferences.activityPermissions) return {
    collection: preferences.activityPermissions.collection === true,
    learning: preferences.activityPermissions.learning === true,
    proactive: preferences.activityPermissions.proactive === true,
  };
  return {
    collection: preferences.enabled === true,
    learning: Boolean(preferences.modelProfileId) && !preferences.processingPaused,
    proactive: preferences.proactiveEnabled === true,
  };
}

export function hasActivityModel(activity, preferences, models) {
  const profile = activity === "proactive"
    ? preferences.proactiveModelProfileId || preferences.modelProfileId
    : preferences.modelProfileId;
  if (!profile) return false;
  if (!models) return true;
  return models.some((model) => model.id === profile);
}

function isActivityRunning(activity, preferences) {
  if (activity === "collection") return preferences.enabled === true;
  if (activity === "proactive") return preferences.proactiveEnabled === true;
  return Boolean(preferences.modelProfileId) && !preferences.processingPaused;
}

export function activityStatePatch(activity, preferences, running) {
  const keys = { collection: "enabled", learning: "processingPaused", proactive: "proactiveEnabled" };
  const patch = { [keys[activity]]: activity === "learning" ? !running : running };
  if (!preferences.activityPermissions) patch.activityPermissions = readActivityPermissions(preferences);
  return patch;
}

export function activityControl(activity, snapshot) {
  const definition = activities[activity];
  const preferences = snapshot.status?.preferences || {};
  if (isActivityRunning(activity, preferences))
    return { action: "stop", label: `Stop ${definition.label}`, tone: "danger" };
  if (!hasActivityModel(activity, preferences, snapshot.models))
    return { action: "setup", label: `Set up ${definition.label}`, tone: "setup",
      field: activity === "proactive" ? "proactiveModelProfileId" : "modelProfileId" };
  if (!readActivityPermissions(preferences)[activity])
    return { action: "setup", label: `Set up ${definition.label}`, tone: "setup", field: definition.permissionField };
  return { action: "start", label: `Start ${definition.label}`, tone: "default" };
}

export function homeActivityStartPatch(snapshot) {
  const preferences = snapshot.status?.preferences || {};
  const permissions = readActivityPermissions(preferences);
  const approved = Object.keys(activities).filter((activity) => permissions[activity]);
  if (!approved.length) return null;
  // Home does not load model choices; saved profiles are validated by configure.
  if (approved.some((activity) => !hasActivityModel(activity, preferences))) return null;
  return Object.assign({}, ...approved.map((activity) => activityStatePatch(activity, preferences, true)));
}

export function handleActivityControlClick(root, event, actions, openSettings) {
  for (const [activity, definition] of Object.entries(activities)) {
    const button = event.target.closest(definition.selector);
    if (!button || !root.contains(button)) continue;
    const snapshot = actions.snapshot();
    if (button.disabled || snapshot.saving || snapshot.loadingStatus || !snapshot.status) return true;
    const control = activityControl(activity, snapshot);
    if (control.action === "setup") {
      openSettings();
      root.querySelector(`[data-learning-setting="${control.field}"]`)?.focus();
      return true;
    }
    void actions.configure(activityStatePatch(activity, snapshot.status.preferences, control.action === "start"));
    return true;
  }
  return false;
}

export function renderActivityControls(root, snapshot) {
  for (const [activity, definition] of Object.entries(activities)) {
    const button = root.querySelector(definition.selector);
    const control = activityControl(activity, snapshot);
    button.disabled = Boolean(snapshot.saving || snapshot.loadingStatus || !snapshot.status);
    button.textContent = control.label;
    button.dataset.actionTone = control.tone;
  }
}
