import { escapeHtml } from "../../lib/text-format.js";
import {
  renderProviderChoices,
  renderConnectionField,
} from "./connection-form.js";
import { buildBridgeSetupCommands } from "./commands.js";
import { renderWizardShell } from "./wizard-shell.js";

const PROVIDERS = [
  {
    id: "ollama",
    label: "Ollama",
    description: "A model on your computer or server",
  },
  { id: "openai", label: "OpenAI", description: "A hosted model" },
];

function commandBlock(id, label, command) {
  return `<div class="runtime-bridge-command"><div><span>${escapeHtml(label)}</span><button type="button" data-runtime-setup-action="copy" data-runtime-command="${id}" aria-describedby="runtimeBridgeCopy-${id}">Copy</button></div>
    <pre><code>${escapeHtml(command)}</code></pre><small id="runtimeBridgeCopy-${id}" data-runtime-copy-status="${id}" aria-live="polite"></small></div>`;
}

function connectionMarkup(state) {
  let content = renderProviderChoices({ ...state, providers: PROVIDERS });
  content += renderConnectionField({
    field: "model-id",
    label: "Model ID",
    value: state.modelId,
    placeholder: "Exact model name",
    help: "Enter the model name provided by your service.",
  });
  if (state.provider === "ollama")
    content += renderConnectionField({
      field: "ollama-base-url",
      label: "Ollama address",
      type: "url",
      value: state.baseUrl,
      help: "Use the address reachable from the computer running the runtime.",
    });
  return content;
}

function commandsMarkup(state, commandMode) {
  const commands = buildBridgeSetupCommands(
    state.provider,
    state.modelId,
    state.baseUrl,
    commandMode,
  );
  let content =
    '<p class="runtime-setup-feedback">Run these commands in the runtime project used by your Bridge. This page cannot run commands or restart services.</p>';
  if (state.provider === "ollama")
    content += commandBlock(
      "ollama-pull",
      "Ollama host · download the model",
      commands["ollama-pull"],
    );
  content += commandBlock("setup", "Runtime host · initialize", commands.setup);
  if (state.provider === "openai")
    content +=
      '<p class="runtime-setup-feedback">After initialization, set <code>OPENAI_API_KEY</code> in the runtime’s <code>.env</code> with your local editor or secret manager. Keep the key out of this page and terminal commands.</p>';
  content +=
    '<p class="runtime-setup-feedback">The initializer preserves existing files. Restart the runtime services and Bridge after changing configuration so they load the new settings.</p>';
  if (commands["model-gateway"])
    content += commandBlock(
      "model-gateway",
      "Restart the model gateway",
      commands["model-gateway"],
    );
  content +=
    '<p class="runtime-setup-feedback">Restart this Web UI using its original Bridge launch command or service configuration. Preserve <code>LLM_RUNTIME_WEB_BACKEND=bridge</code>, the configured Bridge URLs, and authentication settings.</p>';
  return content;
}

export function renderBridgeSetup(state, availability, commandMode) {
  const checking = availability.status === "checking";
  let feedback = "";
  if (state.error)
    feedback = `<p class="runtime-setup-feedback error" role="alert">${escapeHtml(state.error)}</p>`;
  else if (checking)
    feedback =
      '<p class="runtime-setup-feedback" role="status">Checking the model catalog…</p>';
  else if (availability.status === "error")
    feedback = `<p class="runtime-setup-feedback error" role="alert">Could not check the model catalog. ${escapeHtml(availability.message)}</p>`;
  const disabled = checking ? "disabled" : "";
  const check = `<button type="button" class="runtime-setup-action" data-runtime-setup-action="check" ${disabled}>${checking ? "Checking…" : "Check again"}</button>`;
  const footer =
    state.step === 0
      ? `${check}<button type="submit" class="runtime-setup-action" ${checking || !state.provider ? "disabled" : ""}>Show commands</button>`
      : `<button type="button" class="runtime-setup-secondary" data-runtime-setup-action="back" ${disabled}>Back</button>${check}`;
  return renderWizardShell({
    steps: ["Provider", "Commands"],
    step: state.step,
    title:
      state.step === 0
        ? "Connect the external runtime"
        : "Finish setup on the runtime host",
    description:
      "This Web UI connects through a Bridge. Configure its runtime, then check model availability again.",
    content:
      (state.step === 0
        ? connectionMarkup(state)
        : commandsMarkup(state, commandMode)) + feedback,
    footer,
    busy: checking,
  });
}
