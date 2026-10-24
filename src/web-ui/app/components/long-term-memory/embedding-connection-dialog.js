import { createEmbeddingSetupStep } from "../runtime-setup/embedding.js";
import { embeddingProviderOptions } from "../runtime-setup/embedding-provider-options.js";
import { renderMemoryEmbeddingConnection } from "./embedding-connection-rendering.js";

export function createMemoryEmbeddingConnectionDialog({
  root,
  getEnvironmentId = () => "",
  loadStatus,
  saveConnection,
  discoverModels,
  beginRuntimeMutation = () => true,
  endRuntimeMutation = () => {},
  refreshRuntimeConfig = async () => true,
  onSaved = () => {},
  onApplied = async () => {},
  applyConfiguration,
  onClosed = () => {},
}) {
  const dialog = root.ownerDocument.createElement("dialog");
  dialog.className = "model-setup-dialog";
  dialog.setAttribute("aria-labelledby", "memoryEmbeddingConnectionTitle");
  root.append(dialog);
  const state = { saved: false, applying: false, notice: "", error: "" };
  let generation = 0;
  let environmentId = "";
  let memoryOptions = {};
  let activeMutation = null;
  let saveCompleted = false;
  const currentOperation = () => ({ generation, environmentId });
  const isCurrentOperation = (operation) =>
    dialog.open &&
    operation.generation === generation &&
    operation.environmentId === getEnvironmentId();
  const hasActiveMutation = () => Boolean(activeMutation);
  const isBusy = () =>
    state.applying || embedding.state.busy || hasActiveMutation();
  const canEditEmbeddingConnection = () => !state.saved && !isBusy();
  const canApplyMemoryConfiguration = () => state.saved && !isBusy();
  const embedding = createEmbeddingSetupStep({
    container: dialog,
    getEnvironmentId,
    loadStatus: () => loadStatus(environmentId),
    discoverModels: (providerId) => discoverModels(providerId, environmentId),
    saveEmbedding: save,
    onChange: render,
    onComplete: () => {
      if (!saveCompleted) {
        close();
        return;
      }
      state.saved = true;
      render();
    },
  });

  function render() {
    if (!dialog.open) return;
    dialog.innerHTML = renderMemoryEmbeddingConnection(state, embedding);
  }

  function acquireMutation(operation) {
    if (!beginRuntimeMutation(operation.environmentId)) return null;
    const mutation = { ...operation, released: false };
    activeMutation = mutation;
    return mutation;
  }

  function releaseMutation(mutation) {
    if (!mutation || mutation.released) return;
    mutation.released = true;
    if (activeMutation === mutation) activeMutation = null;
    endRuntimeMutation(mutation.environmentId);
  }

  async function refreshSavedConfiguration(operation, payload) {
    if (!isCurrentOperation(operation)) return;
    onSaved(payload, operation.environmentId);
    try {
      const refreshed = await refreshRuntimeConfig(operation.environmentId);
      if (!isCurrentOperation(operation)) return;
      if (refreshed === false)
        state.notice =
          "Configuration saved. Refresh Memory settings before continuing.";
    } catch {
      if (isCurrentOperation(operation))
        state.notice =
          "Configuration saved. Refresh Memory settings before continuing.";
    }
  }

  async function save(input) {
    const operation = currentOperation();
    const mutation = acquireMutation(operation);
    if (!mutation)
      throw Object.assign(new Error("Configuration is busy"), {
        payload: {
          message:
            "Save or reset configuration changes before adding an embedding connection.",
        },
      });
    state.error = "";
    state.notice = "";
    try {
      let payload;
      try {
        payload = await saveConnection(
          input,
          { ...memoryOptions },
          operation.environmentId,
        );
      } catch (error) {
        if (hasSavedEmbeddingProviderReceipt(error))
          await refreshSavedConfiguration(operation, error.payload);
        throw error;
      }
      if (!isCurrentOperation(operation)) return payload;
      await refreshSavedConfiguration(operation, payload);
      if (isCurrentOperation(operation))
        saveCompleted = hasEnabledMemoryConfiguration(payload);
      return payload;
    } finally {
      releaseMutation(mutation);
    }
  }

  async function apply() {
    if (!canApplyMemoryConfiguration()) return false;
    const operation = currentOperation();
    const mutation = acquireMutation(operation);
    if (!mutation) {
      state.error =
        "Save or reset configuration changes before applying memory settings.";
      render();
      return false;
    }
    state.applying = true;
    state.error = "";
    state.notice = "";
    render();
    let applied = false;
    try {
      const payload = await applyConfiguration(operation.environmentId);
      if (!isCurrentOperation(operation)) return false;
      if (!hasReadyRuntimeActivation(payload)) {
        state.notice =
          "Memory settings are saved. ABot could not apply them yet; restart it when ready, or try Apply & restart again.";
        return false;
      }
      const refreshed = await refreshRuntimeConfig(operation.environmentId);
      if (!isCurrentOperation(operation)) return false;
      const completed = await onApplied(payload, operation.environmentId);
      if (!isCurrentOperation(operation)) return false;
      if (!hasCompletedMemoryRefresh(refreshed, completed)) {
        state.notice =
          "Memory configuration applied. Refresh Memory settings before continuing.";
        return false;
      }
      applied = true;
      return applied;
    } catch {
      if (isCurrentOperation(operation))
        state.error =
          "Memory settings are saved. Applying them failed; try Apply & restart again.";
      return false;
    } finally {
      releaseMutation(mutation);
      if (isCurrentOperation(operation)) {
        state.applying = false;
        if (applied) close(true);
        else render();
      }
    }
  }

  function close(completed = false) {
    if (isBusy()) return false;
    const wasOpen = dialog.open;
    generation += 1;
    embedding.reset();
    dialog.close();
    dialog.replaceChildren();
    if (wasOpen) onClosed({ completed });
    return true;
  }

  function environmentChanged() {
    if (environmentId === getEnvironmentId()) return;
    generation += 1;
    embedding.reset();
    releaseMutation(activeMutation);
    state.applying = false;
    const wasOpen = dialog.open;
    dialog.close();
    dialog.replaceChildren();
    if (wasOpen) onClosed({ completed: false });
  }

  async function open(options = {}) {
    if (dialog.open || hasActiveMutation()) return false;
    generation += 1;
    environmentId = getEnvironmentId();
    memoryOptions = { ...options };
    saveCompleted = false;
    Object.assign(state, {
      saved: false,
      applying: false,
      notice: "",
      error: "",
    });
    embedding.reset();
    dialog.showModal();
    render();
    return loadChoices();
  }

  async function loadChoices() {
    const operation = currentOperation();
    await embedding.load();
    if (!isCurrentOperation(operation)) return false;
    if (!embedding.state.loaded) return false;
    const choice = embeddingProviderOptions(embedding.state.providers).find(
      (provider) => provider.id.startsWith("new:"),
    );
    if (choice) embedding.change("embedding-provider", choice.id);
    dialog
      .querySelector('[data-runtime-setup-field="embedding-provider"]')
      ?.focus();
    return true;
  }

  dialog.addEventListener("input", (event) => {
    if (!canEditEmbeddingConnection()) return;
    const field = event.target.dataset.runtimeSetupField;
    if (field) embedding.input(field, event.target.value);
  });
  dialog.addEventListener("change", (event) => {
    if (!canEditEmbeddingConnection()) return;
    embedding.change(
      event.target.dataset.runtimeSetupField,
      event.target.value,
    );
  });
  dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    if (canEditEmbeddingConnection()) void embedding.submit();
  });
  dialog.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-memory-connection-action]")
      ?.dataset.memoryConnectionAction;
    if (action === "close") {
      close();
      return;
    }
    if (action === "apply") {
      void apply();
      return;
    }
    const sharedAction = event.target.closest?.("[data-runtime-setup-action]")
      ?.dataset.runtimeSetupAction;
    if (!sharedAction || isBusy()) return;
    if (sharedAction === "embedding-reload") {
      void loadChoices();
      return;
    }
    embedding.click(sharedAction);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  return { open, close, isOpen: () => dialog.open, environmentChanged };
}

function hasSavedEmbeddingProviderReceipt(error) {
  return error?.payload?.providerSaved === true;
}

function hasEnabledMemoryConfiguration(payload) {
  return payload?.status?.enabled === true;
}

function hasReadyRuntimeActivation(payload) {
  return payload?.activation?.status === "ready";
}

function hasCompletedMemoryRefresh(refreshed, completed) {
  if (refreshed === false) return false;
  return completed !== false;
}
