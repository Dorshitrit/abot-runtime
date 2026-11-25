import { escapeAttribute as attr, escapeHtml as html } from "../../lib/text-format.js";

export const defaultServerSettings = () => ({ startup: "manual", port: 8080, sleepIdleSeconds: 60,
  maxLoadedModels: 2, models: [], embedding: null });
export function serverDescription(server) {
  if (!server) return "Checking local server…";
  if (server.supported === false) return "Managed installation is unavailable on this computer.";
  if (server.errorCode) return "Needs attention · " + server.errorCode.replaceAll("_", " ");
  if (!server.configured) return "Set up local models without a terminal";
  const models = server.models || [];
  const sleeping = models.filter(model => model.state === "sleeping").length;
  return [server.phase === "ready" ? "Running" : server.phase.replaceAll("_", " "),
    server.settings.models.length + " chat models", sleeping ? sleeping + " sleeping" : "",
    server.settings.embedding ? "Embeddings configured" : ""].filter(Boolean).join(" · ");
}
function input(key, label, value, type = "text", extra = "") {
  return `<label class="runtime-setup-field"><span>${html(label)}</span><input data-llama-field="${key}" type="${type}" value="${attr(value)}" ${extra} autocomplete="off" spellcheck="false"></label>`;
}
function modelRow(model, index, cpuOnly) {
  const prefix = index === "embedding" ? "embedding" : "model:" + index;
  return `<article class="llama-server-model"><header><strong>${html(model.alias)}</strong><button type="button" class="runtime-setup-inline-action" data-llama-action="remove" data-index="${index}" aria-label="Remove ${attr(model.alias)}">Remove</button></header>
    <p class="runtime-setup-feedback">${html(model.modelPath)}</p><div class="llama-server-fields">
    ${input(prefix + ":contextTokens", "Context per request (tokens)", model.contextTokens, "number", 'min="512" max="131072"')}
    ${input(prefix + ":gpuLayers", "GPU layers", model.gpuLayers, "text", cpuOnly ? 'disabled title="This installation is CPU only"' : 'placeholder="auto or a number"')}
    ${index === "embedding" ? input("embedding:port", "Embedding port", model.port, "number", 'min="1024" max="65535"') + input("embedding:batchTokens", "Embedding batch tokens", model.batchTokens, "number", 'min="1"') : ""}
    </div>${model.templatePath ? `<p class="runtime-setup-feedback">Custom template: ${html(model.templatePath)}</p>` : ""}</article>`;
}
export function renderServerDialog(state) {
  const server = state.server, settings = state.draft;
  const busy = state.busy || server?.busy;
  const running = server?.ownsProcess;
  const locked = busy || running;
  const disable = value => value ? " disabled" : "";
  const action = (name, label, blocked, primary = false) => `<button type="button" class="runtime-setup-inline-action${primary ? " llama-server-primary" : ""}" data-llama-action="${name}"${disable(blocked)}>${label}</button>`;
  return `<section class="runtime-setup-panel model-setup-panel llama-server-panel" aria-labelledby="llama-server-title">
    <header class="llama-server-heading"><h2 id="llama-server-title">Local llama.cpp server</h2><button type="button" data-llama-action="close" aria-label="Close local server settings">×</button></header>
    <div class="runtime-setup-content"><p class="runtime-setup-feedback" role="status">${html(serverDescription(server))}</p>
    <p class="runtime-setup-feedback">ABot owns this server. Closing this window keeps it running; stopping ABot stops it and its model processes.</p>
    ${server?.legacyOwnsProcess ? '<p class="runtime-setup-feedback">The earlier single-model engine is still running.</p>' + action("stop-legacy", "Stop earlier managed engine", busy) : ""}
    ${server?.installation !== "installed" ? `<p class="runtime-setup-feedback">Install the engine once. Models stay on your computer and are never downloaded by this setup.</p>${server?.release ? `<details data-llama-section="download"><summary>Engine download</summary><p>${html(server.release.tag)} · ${html(server.release.name)} · ${html(server.release.size)} bytes</p></details>` : ""}${action("install", busy === "install" ? "Installing…" : "Download and install engine", busy || running || server?.legacyOwnsProcess || server?.supported === false)}` : ""}
    <fieldset class="llama-server-settings"${disable(locked)}><legend>Server settings</legend><div class="llama-server-fields">
      <label class="runtime-setup-field"><span>When to start</span><select data-llama-field="startup"><option value="manual"${settings.startup === "manual" ? " selected" : ""}>Start manually</option><option value="with-abot"${settings.startup === "with-abot" ? " selected" : ""}>Start with ABot</option></select></label>
      ${input("port", "Chat server port", settings.port, "number", 'min="1024" max="65535"')}
      ${input("sleepIdleSeconds", "Sleep after idle (seconds)", settings.sleepIdleSeconds, "number", 'min="-1" max="86400"')}
      ${input("maxLoadedModels", "Maximum loaded chat models", settings.maxLoadedModels, "number", 'min="1" max="8"')}
    </div><p class="runtime-setup-feedback">Use −1 to disable automatic sleep. Sleep frees model memory; the next request wakes the model. Stop keeps the server off until you start it, or until the next ABot launch if “Start with ABot” is selected.</p>
    <div class="llama-server-models">${settings.models.map((model, index) => modelRow(model, index, server?.cpuOnly)).join("") || '<p class="runtime-setup-feedback">Add at least one chat model.</p>'}</div>
    ${settings.embedding ? `<h3>Embedding server</h3>${modelRow(settings.embedding, "embedding", server?.cpuOnly)}` : ""}
    <details class="llama-server-add" data-llama-section="models"><summary>Add local models</summary>
      ${action("discover", "Find models installed by Ollama", locked)}
      <p class="runtime-setup-feedback">Only reads local model metadata. Choose which models to add below.</p>
      <div class="llama-server-candidates">${state.candidates.map((candidate, index) => `<div><span>${html(candidate.model.alias)} · ${html(candidate.kind)}</span>${action("add-candidate:" + index, candidate.kind === "embedding" ? "Use for embeddings" : "Add", locked)}</div>`).join("")}</div>
      ${state.skipped.length ? `<details data-llama-section="skipped"><summary>${state.skipped.length} models need attention</summary>${state.skipped.map(entry => `<p class="runtime-setup-feedback">${html(entry.alias)}: ${html(entry.reason)}</p>`).join("")}</details>` : ""}
      ${input("candidate:modelPath", "Absolute GGUF path", state.candidate.modelPath)}
      ${input("candidate:alias", "Model name", state.candidate.alias)}
      <details data-llama-section="advanced"><summary>Advanced model files</summary>${input("candidate:templatePath", "Custom Jinja template path (optional)", state.candidate.templatePath)}${input("candidate:projectorPath", "Vision projector path (optional)", state.candidate.projectorPath)}</details>
      ${action("inspect-model", "Check and add GGUF", locked || !state.candidate.modelPath || !state.candidate.alias)}
    </details></fieldset>
    ${running ? '<p class="runtime-setup-feedback">Stop the server before changing its models, startup or sleep settings.</p>' : ""}
    ${state.dirty ? '<p class="runtime-setup-feedback">Unsaved settings. Save before starting, or discard your draft and reload the saved settings.</p>' : ""}
    ${state.error ? `<p class="runtime-setup-feedback error" role="alert">${html(state.error)}</p>` : ""}
    </div><footer class="llama-server-actions">
      ${action("refresh", "Refresh status", busy)}
      ${action("save", "Save settings", locked || !state.dirty || !settings.models.length || server?.installation !== "installed")}
      ${action("discard", "Discard draft and reload", busy || !state.dirty)}
      ${action("start", "Start server", busy || running || !server?.configured || state.dirty, true)}
      ${action("stop", busy ? "Cancel / stop" : "Stop server", state.busy === "stop" || (!running && !server?.busy && !state.busy))}
    </footer></section>`;
}
