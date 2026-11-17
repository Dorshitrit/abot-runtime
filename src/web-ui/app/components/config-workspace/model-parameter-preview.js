function generationCandidate(config) {
  return config && typeof config === "object" ? config : {};
}

function nativeOptionsCandidate(state, file) {
  const keys = state.configDashboard?.modelParameters?.[file.id]?.model?.nativeOptionKeys;
  if (!keys?.length) return {};
  const options = file.config?.options ?? {};
  return { options: Object.fromEntries(keys.filter((key) => Object.hasOwn(options, key)).map((key) => [key, options[key]])) };
}

function configObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function referencedModelDeclaration(dashboard, file) {
  const declaration = dashboard?.files?.runtime?.config?.models?.profiles?.[file?.id];
  return typeof declaration?.configRef === "string" ? declaration : {};
}

function previewDependencyFiles(state) {
  const dashboard = state.configDashboard;
  const files = dashboard?.files?.models ?? [];
  const selected = files.find((file) => file.id === state.selectedConfigModelId);
  if (!selected) return [];
  const rawCalibration = configObject(selected.config?.calibration);
  const inlineCalibration = configObject(referencedModelDeclaration(dashboard, selected).calibration);
  const ids = new Set([selected.id]);
  for (const slot of new Set([...Object.keys(rawCalibration), ...Object.keys(inlineCalibration)])) {
    const target = { ...configObject(rawCalibration[slot]), ...configObject(inlineCalibration[slot]) }.profileId;
    if (typeof target === "string" && target.trim()) ids.add(target.trim());
  }
  return files.filter((file) => ids.has(file.id));
}

export function modelParameterPreviewCandidate(state) {
  const dashboard = state.configDashboard;
  const configuredProviders = dashboard?.files?.runtime?.config?.models?.providers ?? {};
  const files = previewDependencyFiles(state);
  const providerIds = new Set(files.flatMap((file) => [file.config?.provider, referencedModelDeclaration(dashboard, file).provider])
    .filter((id) => typeof id === "string"));
  return {
    modelId: state.selectedConfigModelId,
    providers: Object.fromEntries([...providerIds].map((id) => [id, { type: configuredProviders[id]?.type }])),
    models: files.map((file) => ({
      id: file.id,
      provider: file.config?.provider,
      model: file.config?.model,
      supportsThinking: file.config?.supportsThinking,
      generation: generationCandidate(file.config?.generation),
      ...nativeOptionsCandidate(state, file),
      calibration: Object.fromEntries(Object.entries(file.id === state.selectedConfigModelId ? file.config?.calibration ?? {} : {}).map(([id, calibration]) => [id, {
        profileId: calibration?.profileId,
        generation: generationCandidate(calibration?.generation),
      }])),
    })),
  };
}

function captureFocusedControl(root) {
  const active = root?.ownerDocument?.activeElement;
  if (!active || !root.contains(active)) return undefined;
  if (!active.dataset?.configAction) return undefined;
  const identity = { ...active.dataset };
  const start = active.selectionStart;
  const end = active.selectionEnd;
  return () => {
    for (const element of root.querySelectorAll("[data-config-action]")) {
      if (!Object.entries(identity).every(([key, value]) => element.dataset[key] === value)) continue;
      element.focus({ preventScroll: true });
      if (typeof start === "number" && typeof end === "number") element.setSelectionRange?.(start, end);
      return;
    }
  };
}

function annotateDraftSources(state, modelId, presentation) {
  const file = state.configDashboard.files.models.find((item) => item.id === modelId);
  const baseline = state.baselinesByKey.get(`model:${modelId}`);
  if (!file || !baseline) return;
  const scopes = [[presentation.model, file.config.generation, baseline.generation]];
  for (const [id, metadata] of Object.entries(presentation.calibration ?? {})) {
    scopes.push([metadata, file.config.calibration?.[id]?.generation, baseline.calibration?.[id]?.generation]);
  }
  for (const [metadata, generation, previous] of scopes) {
    for (const field of metadata?.parameters ?? []) {
      const control = generation?.parameters?.[field.key];
      if (control?.mode !== "value") continue;
      if (JSON.stringify(control) === JSON.stringify(previous?.parameters?.[field.key])) continue;
      field.source = "manual";
    }
  }
}

export function createModelParameterPreview({ state, root, previewParameters, renderConfigDashboard, reconcileDrafts = () => {} }) {
  let requestGeneration = 0;
  function redraw() {
    const restoreFocus = captureFocusedControl(root);
    renderConfigDashboard();
    restoreFocus?.();
  }
  function pendingScopes(metadata) {
    return [metadata?.model, ...Object.values(metadata?.calibration ?? {})].filter(Boolean);
  }
  function disableStaleRecommendations(modelId) {
    for (const button of root?.querySelectorAll?.('[data-config-action="model-parameters-recommended"]') ?? []) {
      if (button.dataset.id === modelId) button.disabled = true;
    }
  }
  function invalidate() {
    requestGeneration += 1;
    const modelId = state.selectedConfigModelId;
    for (const metadata of pendingScopes(state.configDashboard?.modelParameters?.[modelId])) {
      metadata.stale = true;
      metadata.pending = false;
    }
    disableStaleRecommendations(modelId);
  }
  async function refresh() {
    if (!previewParameters || !state.configDashboard) return;
    const dashboard = state.configDashboard;
    const candidate = modelParameterPreviewCandidate(state);
    if (!candidate.modelId) return;
    const fingerprint = JSON.stringify(candidate);
    const generation = ++requestGeneration;
    for (const metadata of pendingScopes(dashboard.modelParameters?.[candidate.modelId])) {
      metadata.pending = true;
      metadata.stale = true;
    }
    disableStaleRecommendations(candidate.modelId);
    try {
      const response = await previewParameters(candidate);
      if (generation !== requestGeneration || state.configDashboard !== dashboard) return;
      if (JSON.stringify(modelParameterPreviewCandidate(state)) !== fingerprint) return;
      if (!response?.presentation) throw new Error("model_parameter_preview_missing");
      reconcileDrafts(candidate.modelId, response.presentation);
      annotateDraftSources(state, candidate.modelId, response.presentation);
      dashboard.modelParameters ??= {};
      dashboard.modelParameters[candidate.modelId] = response.presentation;
      redraw();
      if (JSON.stringify(modelParameterPreviewCandidate(state)) !== fingerprint) void refresh();
    } catch {
      if (generation !== requestGeneration || state.configDashboard !== dashboard) return;
      if (JSON.stringify(modelParameterPreviewCandidate(state)) !== fingerprint) return;
      const metadata = dashboard.modelParameters?.[candidate.modelId];
      if (!metadata) return;
      for (const scope of pendingScopes(metadata)) {
        scope.pending = false;
        scope.stale = true;
        scope.warnings = [{ code: "parameter_preview_unavailable", message: "Parameter preview is unavailable. You can continue editing; recommendations are unavailable until preview succeeds." }];
      }
      redraw();
    }
  }
  return { invalidate, refresh };
}
