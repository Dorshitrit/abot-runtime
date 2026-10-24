import { escapeHtml } from "../../lib/text-format.js";


export function renderConnectionInspection(state) {
  return `<div class="runtime-setup-field"><button type="button" class="runtime-setup-secondary" data-runtime-setup-action="inspect-model-connection" data-model-action="inspect-model-connection" ${state.checkingConnection ? "disabled" : ""}>${state.checkingConnection ? "Checking…" : "Check connection"}</button>
    <small role="status" data-connection-inspection-message>${escapeHtml(state.connectionInspectionMessage || "Reads server health and model IDs only. Does not generate a response or save settings.")}</small></div>`;
}

/** Metadata inspection has no authority to infer model capabilities or alter saved setup. */
export function createConnectionInspection({ state, container, inspectConnection, onChange, getEnvironmentId = () => "" }) {
  let generation = 0;
  const identity = () => JSON.stringify([getEnvironmentId(), state.choice || state.provider, state.baseUrl]);
  function updateInspectionFeedback() {
    const button = container.querySelector('[data-runtime-setup-action="inspect-model-connection"]');
    if (button) {
      button.disabled = state.checkingConnection === true;
      button.textContent = state.checkingConnection ? "Checking…" : "Check connection";
    }
    const message = container.querySelector("[data-connection-inspection-message]");
    if (message) message.textContent = state.connectionInspectionMessage;
  }
  function reset() {
    generation += 1;
    state.checkingConnection = false;
    state.connectionInspectionMessage = "";
  }
  async function check() {
    if (!inspectConnection || state.checkingConnection) return;
    const current = ++generation;
    const target = identity();
    const savedId = state.choice?.startsWith("existing:") ? state.choice.slice(9) : undefined;
    const input = savedId
      ? { providerId: savedId }
      : { provider: "llamacpp", baseUrl: state.baseUrl };
    const apiKey = container.querySelector('[data-runtime-setup-field="api-key"]')?.value?.trim() || "";
    if (apiKey) input.apiKey = apiKey;
    state.checkingConnection = true;
    state.connectionInspectionMessage = "";
    updateInspectionFeedback();
    try {
      const payload = await inspectConnection(input);
      if (current !== generation || target !== identity()) return;
      const models = payload?.connection?.models || [];
      state.connectionInspectionMessage = `Server ready. Available models: ${models.join(", ") || "none reported"}. Thinking support and context capacity still require model configuration.`;
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
  return { check, reset };
}
