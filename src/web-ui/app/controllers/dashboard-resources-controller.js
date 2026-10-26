import { createBasketPickerController } from "./information-basket-picker-controller.js";
import { projectBasketAttention } from "../lib/information-basket-attention.js";

/** Home reads committed metadata; source changes remain revision-bound Runtime operations. */
export function createDashboardResourcesController({ client, getEnvironmentId, render,
  isInteractive = () => true, notify = () => {} }) {
  let epoch = 0;
  let readVersion = 0;
  let environmentId = getEnvironmentId();
  let view = null;
  let loading = false;
  let error = "";
  let mutation = "";
  let mutationError = "";
  let message = "";
  let pendingRead = null;
  let refreshAgain = false;
  let relinkTarget = null;
  const picker = createBasketPickerController({ client, getEnvironmentId,
    render: () => render(), register: submitRelink,
    getRegistrationError: () => mutationError, getSelectionLimit: () => 1 });
  const capture = () => ({ epoch, environmentId: getEnvironmentId() });
  function hasCurrentResourceScope(scope) {
    if (scope.epoch !== epoch) return false;
    return scope.environmentId === getEnvironmentId();
  }
  function canReadResourceAttention() {
    if (!isInteractive()) return false;
    return client.supportsInformationBasket?.() === true;
  }
  function snapshot() {
    const current = environmentId === getEnvironmentId();
    return { resourceAttention: {
      supported: client.supportsInformationBasket?.() === true,
      issues: current ? projectBasketAttention(view) : [],
      error: current ? error : "", mutation: current ? mutation : "",
      mutationError: current ? mutationError : "", message: current ? message : "",
      loading: current && loading,
      picker: { ...picker.snapshot(), open: current && picker.snapshot().open },
    } };
  }
  function closePicker() { relinkTarget = null; picker.close(); }
  function invalidate() {
    epoch += 1;
    readVersion += 1;
    environmentId = getEnvironmentId();
    view = null;
    loading = false;
    error = "";
    mutation = "";
    mutationError = "";
    message = "";
    pendingRead = null;
    refreshAgain = false;
    closePicker();
  }
  function canClearResolvedResourceError(result) {
    if (picker.snapshot().open) return false;
    return projectBasketAttention(result).length === 0;
  }
  async function readMetadata() {
    const scope = capture();
    const version = ++readVersion;
    environmentId = scope.environmentId;
    loading = true;
    render();
    function isCurrentMetadataRead() {
      if (!hasCurrentResourceScope(scope)) return false;
      return version === readVersion;
    }
    try {
      const result = await client.listInformationBasket(scope.environmentId);
      if (!isCurrentMetadataRead()) return;
      view = result;
      error = "";
      if (canClearResolvedResourceError(result)) mutationError = "";
    } catch {
      if (isCurrentMetadataRead()) error = "Resource status could not be refreshed. The information below may be out of date.";
    } finally {
      if (isCurrentMetadataRead()) { loading = false; render(); }
    }
  }
  function refresh() {
    if (!canReadResourceAttention()) return Promise.resolve();
    if (environmentId !== getEnvironmentId()) invalidate();
    if (mutation) { refreshAgain = true; return Promise.resolve(); }
    if (pendingRead) { refreshAgain = true; return pendingRead; }
    const scope = capture();
    const pending = readMetadata().finally(() => {
      if (!hasCurrentResourceScope(scope) || pendingRead !== pending) return;
      pendingRead = null;
      if (!refreshAgain) return;
      refreshAgain = false;
      void refresh();
    });
    pendingRead = pending;
    return pending;
  }
  function currentActionSource(id, action, expectedRevision) {
    if (!canReadResourceAttention() || mutation || error) return null;
    if (environmentId !== getEnvironmentId()) return null;
    const source = projectBasketAttention(view).find(item => item.sourceId === id);
    if (!source || source.action !== action) return null;
    if (expectedRevision !== undefined && source.revision !== expectedRevision) return null;
    return source;
  }
  function actionFailureMessage(failure) {
    const code = failure instanceof Error ? failure.message : String(failure);
    if (code.includes("revision_conflict")) return "This source changed. Refresh its status before trying again.";
    if (code.includes("path_conflict")) return "That file is already linked to another resource. Choose a different file.";
    if (code.includes("not_found")) return "The source or selected file is no longer available. Refresh or choose another file.";
    return "The resource could not be updated. Check the source and try again.";
  }
  async function mutateSource(name, execute, successMessage) {
    if (!canReadResourceAttention() || mutation) return false;
    const scope = capture();
    readVersion += 1;
    loading = false;
    mutation = name;
    mutationError = "";
    message = "";
    render();
    try {
      const result = await execute(scope.environmentId);
      if (!hasCurrentResourceScope(scope)) return false;
      view = result;
      error = "";
      message = successMessage;
      if (isInteractive()) notify(successMessage);
      return true;
    } catch (failure) {
      if (!hasCurrentResourceScope(scope)) return false;
      mutationError = actionFailureMessage(failure);
      refreshAgain = true;
      return false;
    } finally {
      if (hasCurrentResourceScope(scope)) {
        mutation = "";
        render();
        if (refreshAgain) { refreshAgain = false; void refresh(); }
      }
    }
  }
  function reindex(sourceId, expectedRevision) {
    const source = currentActionSource(sourceId, "reindex", expectedRevision);
    if (!source) return Promise.resolve(false);
    return mutateSource("reindex", environment => client.reindexInformationBasketSource(
      source.sourceId, source.revision, environment), "Source queued for indexing.");
  }
  function relink(sourceId, expectedRevision) {
    const source = currentActionSource(sourceId, "relink", expectedRevision);
    if (!source) return Promise.resolve(false);
    relinkTarget = { ...source, scope: capture() };
    mutationError = "";
    return picker.open(source);
  }
  async function submitRelink(paths, sourceId) {
    const target = relinkTarget;
    if (!target || paths.length !== 1 || sourceId !== target.sourceId) return false;
    if (!hasCurrentResourceScope(target.scope)) return false;
    if (!currentActionSource(sourceId, "relink", target.revision)) {
      mutationError = "This source changed while the picker was open. Close it and review the current status.";
      render();
      return false;
    }
    return mutateSource("relink", environment => client.relinkInformationBasketSource(
      target.sourceId, target.revision, paths[0], environment), "Source relinked and queued for indexing.");
  }
  return { snapshot, refresh, invalidate, reindex, relink, picker, closePicker };
}
