import { escapeAttribute, escapeHtml, textOf } from "../lib/text-format.js";

export function createLongTermMemorySetup({
  getEnvironmentId = () => "",
  loadStatus,
  discoverModels,
  enableMemory,
  disableMemory,
  recordControlEvent,
  beginRuntimeMutation = () => true,
  refreshRuntimeConfig = async () => true,
  endRuntimeMutation = () => {},
}) {
  const state = {
    root: null,
    status: null,
    models: [],
    discoverySupported: false,
    busy: "",
    message: "",
    error: "",
    loadRevision: 0,
    actionRevision: 0,
    environmentId: "",
  };

  function mount(root) {
    state.root = root;
    render();
  }

  async function load() {
    const revision = ++state.loadRevision;
    state.actionRevision += 1;
    const environmentId = getEnvironmentId();
    const environmentChanged = state.environmentId !== environmentId;
    if (environmentChanged) {
      state.environmentId = environmentId;
      state.status = null;
      state.models = [];
      state.discoverySupported = false;
    }
    state.busy = "status";
    clearFeedback();
    render({ preserveInputs: !environmentChanged });
    try {
      const payload = await loadStatus(environmentId);
      if (
        revision !== state.loadRevision ||
        environmentId !== getEnvironmentId()
      ) {
        return false;
      }
      state.status = payload.status || null;
      return true;
    } catch (error) {
      if (
        revision !== state.loadRevision ||
        environmentId !== getEnvironmentId()
      ) {
        return false;
      }
      state.error = errorMessage(error);
      return false;
    } finally {
      if (
        revision === state.loadRevision &&
        environmentId === getEnvironmentId()
      ) {
        state.busy = "";
        render();
      }
    }
  }

  async function discover() {
    const providerId = selectedProviderId();
    if (!providerId) {
      showError("Choose a configured provider first.");
      return;
    }
    await runAction(
      "discover",
      (environmentId) => discoverModels(providerId, environmentId),
      (payload) => {
        state.models = Array.isArray(payload.catalog?.models)
          ? payload.catalog.models
          : [];
        state.discoverySupported = payload.catalog?.supported === true;
        state.message = discoveryMessage();
      },
    );
  }

  async function enable() {
    const providerId = selectedProviderId();
    const model = textOf(
      state.root?.querySelector("[data-memory-model]")?.value,
    ).trim();
    if (!providerId || !model) {
      showError("Choose a provider and enter an embedding model ID.");
      return;
    }
    const emitClientEvents =
      state.root?.querySelector("[data-memory-events]")?.checked === true;
    await runRuntimeMutation(
      "enable",
      (environmentId) =>
        enableMemory(
          {
            providerId,
            model,
            emitClientEvents,
          },
          environmentId,
        ),
      (payload) => {
        state.status = payload.status || null;
        state.message =
          "Embedding probe passed. Memory is enabled; restart ABot to apply it.";
        recordResult("Long-term memory enabled", payload);
      },
    );
  }

  async function disable() {
    await runRuntimeMutation(
      "disable",
      (environmentId) => disableMemory(environmentId),
      (payload) => {
        state.status = payload.status || null;
        state.message = "Memory is disabled; restart ABot to apply it.";
        recordResult("Long-term memory disabled", payload);
      },
    );
  }

  async function runRuntimeMutation(name, request, applyResult) {
    if (!beginRuntimeMutation()) {
      showError(
        "Save or reset configuration changes before changing memory settings.",
      );
      return false;
    }
    try {
      return await runAction(name, request, async (payload) => {
        applyResult(payload);
        await refreshRuntimeConfig();
      });
    } finally {
      endRuntimeMutation();
    }
  }

  async function runAction(name, request, applyResult) {
    const revision = ++state.actionRevision;
    const environmentId = getEnvironmentId();
    state.loadRevision += 1;
    state.busy = name;
    clearFeedback();
    render();
    try {
      const payload = await request(environmentId);
      if (
        revision !== state.actionRevision ||
        environmentId !== getEnvironmentId()
      ) {
        return false;
      }
      await applyResult(payload);
      return true;
    } catch (error) {
      if (
        revision !== state.actionRevision ||
        environmentId !== getEnvironmentId()
      ) {
        return false;
      }
      state.error = errorMessage(error);
      recordControlEvent({
        type: "control",
        name: "Long-term memory setup failed",
        tone: "failed",
        summary: state.error,
      });
      return false;
    } finally {
      if (
        revision === state.actionRevision &&
        environmentId === getEnvironmentId()
      ) {
        state.busy = "";
        render();
      }
    }
  }

  function render(options = {}) {
    if (!state.root) return;
    const status = state.status || {};
    const providers = Array.isArray(status.providers) ? status.providers : [];
    const preserveInputs = options.preserveInputs !== false;
    const selectedProvider =
      (preserveInputs ? selectedProviderId() : "") ||
      status.providerId ||
      providers[0]?.id ||
      "";
    const selectedModel =
      (preserveInputs ? currentModelValue() : "") || status.model || "";
    const enabled = status.enabled === true;
    state.root.innerHTML = `
      <section class="memory-setup-card" aria-busy="${state.busy ? "true" : "false"}">
        <div class="memory-setup-heading">
          <div>
            <p class="eyebrow">passive memory</p>
            <h4>Long-term memory</h4>
            <p>Retrieve relevant memories across sessions while keeping storage and policy in the Runtime core.</p>
          </div>
          <span class="memory-status ${enabled ? "enabled" : "disabled"}">${enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <div class="memory-setup-fields">
          <label>
            <span>Embedding provider</span>
            <select data-memory-provider ${state.busy ? "disabled" : ""}>
              ${providerOptions(providers, selectedProvider)}
            </select>
          </label>
          <label>
            <span>Embedding model</span>
            <input data-memory-model list="memoryEmbeddingModels" value="${escapeAttribute(selectedModel)}" placeholder="Enter a provider model ID" ${state.busy ? "disabled" : ""} />
            <datalist id="memoryEmbeddingModels">${state.models
              .map(
                (model) =>
                  `<option value="${escapeAttribute(textOf(model))}"></option>`,
              )
              .join("")}</datalist>
          </label>
          <label class="memory-events-toggle">
            <input data-memory-events type="checkbox" ${status.emitClientEvents === true ? "checked" : ""} ${state.busy ? "disabled" : ""} />
            <span>Show bounded memory lifecycle events to clients</span>
          </label>
        </div>
        <div class="memory-setup-actions">
          <button type="button" data-memory-action="discover" ${state.busy ? "disabled" : ""}>Discover models</button>
          <button type="button" data-memory-action="enable" ${state.busy ? "disabled" : ""}>Probe and enable</button>
          <button type="button" data-memory-action="disable" ${!enabled || state.busy ? "disabled" : ""}>Disable</button>
        </div>
        ${feedbackMarkup()}
        <p class="memory-setup-note">ABot never chooses or installs an embedding model. Configuration is written only after a real probe succeeds.</p>
      </section>
    `;
    bindActions();
  }

  function bindActions() {
    state.root.querySelectorAll("[data-memory-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.memoryAction;
        if (action === "discover") void discover();
        else if (action === "enable") void enable();
        else if (action === "disable") void disable();
      });
    });
  }

  function selectedProviderId() {
    return textOf(
      state.root?.querySelector("[data-memory-provider]")?.value,
    ).trim();
  }

  function currentModelValue() {
    return textOf(
      state.root?.querySelector("[data-memory-model]")?.value,
    ).trim();
  }

  function clearFeedback() {
    state.message = "";
    state.error = "";
  }

  function showError(message) {
    state.error = message;
    render();
  }

  function discoveryMessage() {
    if (!state.discoverySupported) {
      return "This provider does not expose model discovery. Enter its embedding model ID manually.";
    }
    return state.models.length
      ? `Found ${state.models.length} installed model${state.models.length === 1 ? "" : "s"}.`
      : "The provider returned no installed models.";
  }

  function feedbackMarkup() {
    if (state.error) {
      return `<p class="memory-setup-feedback error-text" role="alert">${escapeHtml(state.error)}</p>`;
    }
    return state.message
      ? `<p class="memory-setup-feedback" role="status">${escapeHtml(state.message)}</p>`
      : "";
  }

  function recordResult(name, payload) {
    recordControlEvent({
      type: "control",
      name,
      tone: "done",
      summary: payload.backupPath
        ? `backup: ${payload.backupPath}`
        : "restart required",
    });
  }

  return { load, mount };
}

function providerOptions(providers, selectedProvider) {
  if (providers.length === 0) {
    return '<option value="">No configured providers</option>';
  }
  return providers
    .map((provider) => {
      const selected = provider.id === selectedProvider ? "selected" : "";
      return `<option value="${escapeAttribute(provider.id)}" ${selected}>${escapeHtml(provider.id)} · ${escapeHtml(provider.type)}</option>`;
    })
    .join("");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
