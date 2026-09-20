import { applySavedEmbeddingProviderReceipt } from "./embedding-provider-receipt.js";
import { textOf } from "../../lib/text-format.js";
import { renderEmbeddingSetup } from "./embedding-rendering.js";
import {
  DEFAULT_OLLAMA_BASE_URL,
  validateRuntimeSetupBaseUrl,
  validateRuntimeSetupModelId,
} from "./validation.js";

export function createEmbeddingSetupStep({
  container,
  getEnvironmentId,
  getPreferredProvider = () => "",
  loadStatus,
  discoverModels,
  saveEmbedding,
  onChange,
  onComplete,
}) {
  const state = {
    status: null,
    providers: [],
    provider: "",
    model: "",
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    models: [],
    busy: false,
    loaded: false,
    error: "",
    message: "",
  };
  let loadedConnectionProvider = "";
  let preferConnectionProvider = false;
  let generation = 0;
  const isCurrentEmbeddingOperation = (revision, environment) =>
    revision === generation && environment === getEnvironmentId();
  const selectedProvider = () =>
    state.providers.find((entry) => entry.id === state.provider);
  const selectedProviderType = () =>
    selectedProvider()?.type || state.provider.replace("new:", "");
  const hasUnchangedEmbeddingSelection = () =>
    state.status?.enabled === true &&
    state.provider === state.status.providerId &&
    state.model.trim() === state.status.model;

  function clearSecret() {
    const input = container.querySelector(
      '[data-runtime-setup-field="embedding-key"]',
    );
    if (input) input.value = "";
  }

  function reset() {
    generation += 1;
    loadedConnectionProvider = "";
    preferConnectionProvider = false;
    clearSecret();
    Object.assign(state, {
      status: null,
      providers: [],
      provider: "",
      model: "",
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      models: [],
      busy: false,
      loaded: false,
      error: "",
      message: "",
    });
  }

  function invalidateConnection() {
    const { provider, model, baseUrl } = state;
    const connectionProviderChanged =
      loadedConnectionProvider !== getPreferredProvider();
    reset();
    preferConnectionProvider = connectionProviderChanged;
    state.baseUrl = baseUrl;
    if (connectionProviderChanged) return;
    Object.assign(state, { provider, model });
  }

  function retainedEmbeddingProvider() {
    const configured = selectedProvider();
    if (configured) return configured.id;
    const isNewProviderChoice = ["new:openai", "new:ollama"].includes(
      state.provider,
    );
    if (!isNewProviderChoice) return "";
    const hasConfiguredType = state.providers.some(
      (provider) => provider.type === state.provider.slice(4),
    );
    if (hasConfiguredType) return "";
    return state.provider;
  }

  function initialEmbeddingProvider(connectionProvider) {
    const retained = retainedEmbeddingProvider();
    if (retained) return retained;
    const saved = state.providers.find(
      (provider) => provider.id === state.status.providerId,
    );
    const preserveSavedProvider = saved && !preferConnectionProvider;
    if (preserveSavedProvider) return saved.id;
    const matching = state.providers.filter(
      (provider) => provider.type === connectionProvider,
    );
    const preferred =
      matching.find((provider) => provider.id === connectionProvider) ||
      matching[0];
    if (preferred) return preferred.id;
    return saved?.id || state.providers[0]?.id || "new:openai";
  }

  async function run(request, apply, failure, onFailure = () => {}) {
    const revision = ++generation;
    const environment = getEnvironmentId();
    state.busy = true;
    state.error = "";
    clearSecret();
    onChange();
    try {
      const payload = await request();
      if (!isCurrentEmbeddingOperation(revision, environment)) return false;
      apply(payload);
      return true;
    } catch (error) {
      if (!isCurrentEmbeddingOperation(revision, environment)) return false;
      onFailure(error?.payload);
      const message = textOf(error?.payload?.message, failure);
      state.error =
        error?.payload?.providerSaved === true
          ? `${message} The provider connection was saved; memory is unchanged.`
          : message;
      return false;
    } finally {
      if (isCurrentEmbeddingOperation(revision, environment)) {
        state.busy = false;
        clearSecret();
        onChange();
      }
    }
  }

  async function load() {
    if (state.loaded || state.busy) return;
    const connectionProvider = getPreferredProvider();
    await run(
      loadStatus,
      (payload) => {
        state.status = payload.status || {};
        state.providers = state.status.providers || [];
        const hasRetainedProvider = Boolean(retainedEmbeddingProvider());
        state.provider = initialEmbeddingProvider(connectionProvider);
        const restoreSavedModel =
          !hasRetainedProvider && state.provider === state.status.providerId;
        if (restoreSavedModel) state.model = state.status.model || "";
        loadedConnectionProvider = connectionProvider;
        preferConnectionProvider = false;
        state.loaded = true;
      },
      "Could not load embedding options. Try again or set this up later.",
    );
  }

  async function discover() {
    if (state.busy || !selectedProvider()) return;
    await run(
      () => discoverModels(state.provider),
      (payload) => {
        state.models = Array.isArray(payload.catalog?.models)
          ? payload.catalog.models
          : [];
        state.message =
          payload.catalog?.supported === true
            ? `${state.models.length} installed models found. Choose an embedding model.`
            : "This provider does not list models. Enter an embedding model ID.";
      },
      "Could not discover models. You can enter an embedding model ID manually.",
    );
  }

  function apiKeyValue() {
    if (selectedProviderType() !== "openai") return "";
    return textOf(
      container.querySelector('[data-runtime-setup-field="embedding-key"]')
        ?.value,
    ).trim();
  }

  function primaryLabel() {
    return hasUnchangedEmbeddingSelection() && !apiKeyValue()
      ? "Continue"
      : "Test and save";
  }

  async function submit() {
    if (state.busy || !state.loaded) return;
    const apiKey = apiKeyValue();
    if (hasUnchangedEmbeddingSelection() && !apiKey) return onComplete();
    const model = validateRuntimeSetupModelId(state.model);
    if (!model.valid) {
      state.error = "Enter an embedding model ID, or skip this step for now.";
      onChange();
      return;
    }
    const input = selectedProvider()
      ? { providerId: state.provider, model: model.value }
      : { provider: selectedProviderType(), model: model.value };
    if (!selectedProvider() && selectedProviderType() === "ollama") {
      const address = validateRuntimeSetupBaseUrl(state.baseUrl);
      if (!address.valid) {
        state.error = address.message;
        onChange();
        return;
      }
      input.baseUrl = address.value;
    }
    if (selectedProviderType() === "openai" && apiKey) input.apiKey = apiKey;
    const providerSelection = {
      type: selectedProviderType(),
      providerId: input.providerId,
    };
    let saved = false;
    try {
      saved = await run(
        () => saveEmbedding(input),
        (payload) => {
          if (payload.status?.enabled !== true)
            throw new Error("Embedding configuration unavailable");
          state.status = payload.status || {};
          state.providers = state.status.providers || state.providers;
          state.provider = state.status.providerId || state.provider;
          state.model = state.status.model || state.model;
          state.message = "Embedding check passed. Memory is configured.";
        },
        "Embedding check failed. Check the provider, model and connection details, then try again.",
        (payload) =>
          applySavedEmbeddingProviderReceipt(state, payload, providerSelection),
      );
    } finally {
      delete input.apiKey;
    }
    if (saved) onComplete();
  }

  function input(field, value) {
    if (state.busy) return;
    if (field === "embedding-model") state.model = value;
    if (field === "embedding-url") state.baseUrl = value;
    const action = container.querySelector(
      '.runtime-setup-action[type="submit"]',
    );
    if (action) action.textContent = primaryLabel();
  }

  function change(field, value) {
    if (state.busy || field !== "embedding-provider") return;
    clearSecret();
    state.provider = value;
    state.models = [];
    state.message = "";
    state.error = "";
    onChange();
  }

  return {
    state,
    clearSecret,
    reset,
    invalidateConnection,
    load,
    submit,
    input,
    change,
    markup: () =>
      renderEmbeddingSetup(state, selectedProviderType(), selectedProvider()),
    primaryLabel,
    click: (action) => {
      if (action === "embedding-discover") void discover();
      if (action === "embedding-reload") void load();
    },
  };
}
