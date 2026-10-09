function modelSupportsImageInput(model) {
  const modalities = model.config?.capabilities?.inputModalities;
  return Array.isArray(modalities) && modalities.includes("image");
}

function modelSummaryUnavailableValue(state) {
  if (state.loading) return "Loading…";
  if (state.configDashboardError) return "Unavailable";
  if (!state.configDashboard?.files) return "Not loaded";
  return null;
}

function modelChangesLabel(count) {
  if (count === 0) return "All saved";
  return `${count} unsaved ${count === 1 ? "model" : "models"}`;
}

export function modelSummary(state, hasPendingFileChanges) {
  const labels = ["Registered models", "Providers", "Image input", "Model changes"];
  const unavailable = modelSummaryUnavailableValue(state);
  if (unavailable) return {
    label: "Models summary",
    items: labels.map((label) => ({ label, value: unavailable })),
  };
  const models = Array.isArray(state.configDashboard.files.models)
    ? state.configDashboard.files.models : [];
  const registered = models.filter((model) => model.registered === true);
  const providers = new Set(registered.map((model) => model.config?.provider).filter(Boolean));
  const pending = models.filter(hasPendingFileChanges).length;
  return {
    label: "Models summary",
    items: [
      { label: labels[0], value: String(registered.length) },
      { label: labels[1], value: String(providers.size) },
      { label: labels[2], value: String(registered.filter(modelSupportsImageInput).length) },
      { label: labels[3], value: modelChangesLabel(pending), status: true, dirty: pending > 0 },
    ],
  };
}
