import { escapeHtml } from "../../lib/text-format.js";


export function renderConnectionInspection(state) {
  return `<div class="runtime-setup-field"><button type="button" class="runtime-setup-secondary" data-runtime-setup-action="inspect-model-connection" data-model-action="inspect-model-connection" ${state.checkingConnection ? "disabled" : ""}>${state.checkingConnection ? "Checking…" : inspectionLabel(state)}</button>
    <small role="status" data-connection-inspection-message>${escapeHtml(state.connectionInspectionMessage || "Reads server health and model IDs only. Does not generate a response or save settings.")}</small></div>`;
}

function inspectionProvider(state) {
  const savedId = state.choice?.startsWith("existing:") ? state.choice.slice(9) : "";
  const saved = state.providers?.find((provider) => provider.id === savedId);
  return state.providerType || saved?.type || state.choice?.replace("new:", "") || state.provider;
}

function inspectionLabel(state) {
  return inspectionProvider(state) === "ollama" ? "Discover models" : "Check connection";
}

function showInstalledModelChoices(container, models) {
  const input = container.querySelector('[data-runtime-setup-field="model-id"]');
  if (!input) return;
  let choices = container.querySelector("[data-connection-models]");
  if (!choices) {
    choices = container.ownerDocument.createElement("datalist");
    choices.setAttribute("id", `${input.getAttribute("aria-describedby")?.split(" ")[0] || "runtimeModel"}-installed`);
    choices.setAttribute("data-connection-models", "true");
    input.parentElement.append(choices);
  }
  input.setAttribute("list", choices.getAttribute("id"));
  choices.replaceChildren();
  for (const model of models) {
    const option = container.ownerDocument.createElement("option");
    option.value = model;
    choices.append(option);
  }
}

/** Metadata inspection has no authority to infer model capabilities or alter saved setup. */
export function createConnectionInspection({ state, container, inspectConnection, onChange, getEnvironmentId = () => "" }) {
  let generation = 0;
  let installedModels = null;
  const identity = () => JSON.stringify([getEnvironmentId(), state.choice || state.provider, state.baseUrl]);
  function updateInspectionFeedback() {
    const button = container.querySelector('[data-runtime-setup-action="inspect-model-connection"]');
    if (button) {
      button.disabled = state.checkingConnection === true;
      button.textContent = state.checkingConnection ? "Checking…" : inspectionLabel(state);
    }
    const message = container.querySelector("[data-connection-inspection-message]");
    if (message) message.textContent = state.connectionInspectionMessage;
  }
  function refreshModelWarning() {
    if (!installedModels) return;
    const model = String(state.model ?? state.modelId ?? "").trim();
    const listed = installedModels.some((name) => modelWithDefaultTag(name) === modelWithDefaultTag(model));
    const catalog = "Server ready. Available models: " + (installedModels.join(", ") || "none reported") + ".";
    state.connectionInspectionMessage = model && !listed
      ? "Model '" + model + "' was not found in the discovered Ollama models. Check its name or install it with ollama pull " + model + ". You can still save settings."
      : catalog + " Thinking support and context capacity still require model configuration.";
    updateInspectionFeedback();
  }
  function clearInstalledModels() {
    installedModels = null;
    container.querySelector("[data-connection-models]")?.remove();
    container.querySelector('[data-runtime-setup-field="model-id"]')?.removeAttribute("list");
  }
  function reset() {
    generation += 1;
    state.checkingConnection = false;
    state.connectionInspectionMessage = "";
    clearInstalledModels();
    updateInspectionFeedback();
  }
  async function check() {
    if (!inspectConnection || state.checkingConnection) return;
    const current = ++generation;
    const target = identity();
    const savedId = state.choice?.startsWith("existing:") ? state.choice.slice(9) : undefined;
    const input = savedId
      ? { providerId: savedId }
      : { provider: inspectionProvider(state), baseUrl: state.baseUrl };
    const apiKey = container.querySelector('[data-runtime-setup-field="api-key"]')?.value?.trim() || "";
    if (apiKey) input.apiKey = apiKey;
    state.checkingConnection = true;
    clearInstalledModels();
    state.connectionInspectionMessage = "";
    updateInspectionFeedback();
    try {
      const payload = await inspectConnection(input);
      if (current !== generation || target !== identity()) return;
      const models = payload?.connection?.models || [];
      state.connectionInspectionMessage = `Server ready. Available models: ${models.join(", ") || "none reported"}. Thinking support and context capacity still require model configuration.`;
      if (inspectionProvider(state) === "ollama") {
        installedModels = models;
        showInstalledModelChoices(container, models);
        refreshModelWarning();
      }
    } catch {
      if (current !== generation || target !== identity()) return;
      state.connectionInspectionMessage = "Connection check failed. Check the server address, authentication and loaded model.";
    } finally {
      delete input.apiKey;
      if (current === generation) {
        state.checkingConnection = false;
        updateInspectionFeedback();
      }
    }
  }
  return { check, reset, refreshModelWarning };
}


function modelWithDefaultTag(model) {
  const name = model.slice(model.lastIndexOf("/") + 1);
  return name.includes(":") ? model : model + ":latest";
}
