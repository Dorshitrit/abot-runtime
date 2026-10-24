import { escapeHtml } from "../../lib/text-format.js";
import { renderWizardShell } from "../runtime-setup/wizard-shell.js";

export function renderMemoryEmbeddingConnection(state, embedding) {
  const busy = state.applying || embedding.state.busy;
  const disabled = busy ? "disabled" : "";
  const success = `<p class="runtime-setup-feedback">Embedding probe passed. Memory is configured. Apply the configuration to use it.</p>`;
  const feedback = state.error
    ? `<p class="runtime-setup-feedback error" role="alert">${escapeHtml(state.error)}</p>`
    : state.notice
      ? `<p class="runtime-setup-feedback" role="status">${escapeHtml(state.notice)}</p>`
      : "";
  const action = state.saved
    ? `<button type="button" class="runtime-setup-action" data-memory-connection-action="apply" ${disabled}>${state.applying ? "Applying…" : "Apply &amp; restart"}</button>`
    : `<button type="submit" class="runtime-setup-action" ${busy || !embedding.state.loaded ? "disabled" : ""}>Test and save</button>`;
  return renderWizardShell({
    steps: ["Connection", "Apply"],
    step: state.saved ? 1 : 0,
    title: state.saved
      ? "Embedding connection saved"
      : "Add an embedding connection",
    description: state.saved
      ? "Your memory configuration is ready to apply."
      : "Choose a connection and an embedding model for memory.",
    content: `${state.saved ? success : embedding.markup()}${feedback}`,
    footer: `<button type="button" class="runtime-setup-secondary" data-memory-connection-action="close" ${disabled}>${state.saved ? "Close" : "Cancel"}</button>${action}`,
    busy,
    panelClass: "model-setup-panel",
    idPrefix: "memoryEmbeddingConnection",
  });
}
