import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

const fields = ["modelPath", "alias", "port", "contextTokens", "gpuLayers"];
const pendingPhases = ["installing", "starting", "stopping", "inspecting"];
const defaults = () => ({ mode: "manual", modelPath: "", alias: "", port: "8080",
  contextTokens: "4096", gpuLayers: "0", status: null, capabilities: null,
  busy: "", error: "", retry: "", ready: null });

function launchInput(state) {
  const { modelPath, alias } = state;
  if (!(modelPath.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(modelPath)) || modelPath.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(modelPath) || !modelPath.toLowerCase().endsWith(".gguf"))
    throw new Error("Enter an absolute .gguf path on the ABot host.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(alias))
    throw new Error("Enter a model alias of 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.");
  const result = { modelPath, alias };
  for (const [field, min, max] of [["port", 1024, 65535], ["contextTokens", 512, 131072], ["gpuLayers", 0, 999]]) {
    const value = Number(state[field]);
    if (!/^\d+$/u.test(state[field]) || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(field + " must be an integer from " + min + " to " + max + ".");
    result[field] = value;
  }
  if (state.capabilities?.cpuOnly && result.gpuLayers !== 0) throw new Error("This engine supports CPU only; set GPU layers to zero.");
  return result;
}
// Reject the entire snapshot on schema failure; never retain extra fields.
function validatedPreferences(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== fields.length ||
        Object.keys(value).some(key => !fields.includes(key))) return null;
    if (typeof value.modelPath !== "string" || typeof value.alias !== "string" ||
        ["port", "contextTokens", "gpuLayers"].some(key =>
          typeof value[key] !== "number" || !Number.isSafeInteger(value[key]))) return null;
    return launchInput(value);
  } catch { return null; }
}
function allowed(state, action) {
  if (state.mode !== "managed") return false;
  if (action === "cancel") return ["install", "start"].includes(state.busy) ||
    (!state.busy && ["installing", "starting"].includes(state.status?.phase));
  if (state.busy) return false;
  if (action === "refresh") return true;
  const status = state.status;
  if (action === "stop") return status?.ownsProcess === true;
  if (!status || status.closed || !status.supported || pendingPhases.includes(status.phase)) return false;
  if (action === "use") return Boolean(state.ready) && status.phase === "ready" && status.ownsProcess;
  if (status.ownsProcess) return false;
  if (action === "inspect") return true;
  if (action === "install") return status.installation !== "installed" && Boolean(state.capabilities?.release);
  if (action === "start") return status.installation === "installed";
  return false;
}

/** Pure controller: consumers delegate data-managed-llama-field/action events.
 * onReady runs only on explicit Use, with a snapshot from this binding's successful
 * start. Consumers must still use the server-side managed save handoff. Status
 * can restore validated preferences, never a ready snapshot or Use authorization.
 * Reset/mode changes never stop a host process.
 */
export function createManagedLlamaBinding({ client, getEnvironmentId = () => "", onChange = () => {}, onReady = () => {} }) {
  const state = defaults();
  let environment = getEnvironmentId();
  let revision = 0;
  const editedFields = new Set();
  let initialStatus = true;
  function reset({ notify = true } = {}) {
    revision += 1;
    environment = getEnvironmentId();
    Object.assign(state, defaults());
    editedFields.clear();
    initialStatus = true;
    if (notify) onChange();
  }
  function syncEnvironment() {
    if (environment !== getEnvironmentId()) reset({ notify: false });
  }
  function current(token, env) {
    syncEnvironment();
    return token === revision && env === environment && state.mode === "managed";
  }
  function input(field, value) {
    syncEnvironment();
    if (field === "mode") {
      if (!["manual", "managed"].includes(value) || value === state.mode) return false;
      revision += 1;
      Object.assign(state, { mode: value, busy: "", status: null, capabilities: null, ready: null, error: "", retry: "" });
      onChange();
      return value === "managed" ? action("refresh") : true;
    }
    if (!fields.includes(field) || state.busy) return false;
    state[field] = String(value ?? "");
    editedFields.add(field);
    state.ready = null;
    state.error = "";
    state.retry = "";
    onChange();
    return true;
  }
  async function action(name) {
    syncEnvironment();
    if (name === "retry") name = state.retry;
    if (!allowed(state, name)) return false;
    if (name === "use") {
      await onReady({ ...state.ready });
      return true;
    }
    let payload = {};
    if (name === "start") {
      try { payload = launchInput(state); }
      catch (error) { state.error = error.message; state.retry = ""; onChange(); return false; }
    }
    // Cancel invalidates start success synchronously, before either promise settles.
    const token = ++revision;
    const env = environment;
    state.busy = name;
    state.error = "";
    state.retry = "";
    state.ready = null;
    onChange();
    try {
      const response = name === "refresh"
        ? await client.getManagedLlamaStatus(env)
        : await client.managedLlamaAction(name, payload, env);
      if (!current(token, env)) return false;
      if (response?.ok !== true || !response.status || typeof response.status.supported !== "boolean")
        throw new Error("Invalid managed engine response");
      const preferences = validatedPreferences(response.status.preferences);
      state.status = { ...response.status, preferences };
      if (name === "inspect" || (name === "refresh" && initialStatus)) {
        if (preferences) {
          for (const field of fields) {
            if (!editedFields.has(field)) state[field] = String(preferences[field]);
          }
        }
      }
      if (name === "refresh") initialStatus = false;
      if (name === "refresh") state.capabilities = response.capabilities ?? null;
      if (name === "start") {
        if (state.status.phase !== "ready" || !state.status.ownsProcess || state.status.closed || state.status.errorCode)
          throw new Error("Engine did not become ready");
        state.ready = { managedLlama: true, model: payload.alias,
          baseUrl: "http://127.0.0.1:" + payload.port, contextWindowTokens: payload.contextTokens };
      }
      if (state.status.errorCode) state.error = "Engine reports: " + state.status.errorCode + ". Refresh status or retry the explicit action.";
      return true;
    } catch {
      if (!current(token, env)) return false;
      state.error = "Could not complete " + name + ". Refresh status before retrying if the outcome is uncertain.";
      state.retry = name;
      state.ready = null;
      return false;
    } finally {
      if (current(token, env)) { state.busy = ""; onChange(); }
    }
  }
  return { get state() { syncEnvironment(); return state; }, reset, input, action,
    isBusy() { syncEnvironment(); return Boolean(state.busy); } };
}

export function renderManagedLlama(state, idPrefix = "managedLlama") {
  const id = escapeAttribute(idPrefix);
  const choices = '<label class="runtime-setup-field"><span>llama.cpp connection</span><select id="' + id + '-mode" data-managed-llama-field="mode">' +
    '<option value="manual"' + (state.mode === "manual" ? ' selected' : '') + '>Existing server (manual)</option>' +
    '<option value="managed"' + (state.mode === "managed" ? ' selected' : '') + '>ABot-managed engine</option></select></label>';
  const lifetime = '<p class="runtime-setup-feedback">Switching modes or closing this setup does not stop the engine. It continues until explicit Stop or app close.</p>';
  if (state.mode !== "managed") return choices + '<p class="runtime-setup-feedback">Connect to an existing server using the normal address fields. No managed installation or start is performed.</p>' + lifetime;
  const labels = { modelPath: "Absolute GGUF path on the ABot host", alias: "Model alias", port: "Loopback port", contextTokens: "Context (tokens)", gpuLayers: "GPU layers" };
  const inputs = fields.map(field => '<label class="runtime-setup-field" for="' + id + '-' + field + '"><span>' + labels[field] + '</span><input id="' + id + '-' + field + '" data-managed-llama-field="' + field + '" type="' + (["port", "contextTokens", "gpuLayers"].includes(field) ? 'number' : 'text') + '" value="' + escapeAttribute(state[field]) + '" autocomplete="off" spellcheck="false"' + (state.busy || (field === "gpuLayers" && state.capabilities?.cpuOnly) ? ' disabled' : '') + ' /></label>').join('');
  const button = (name, label) => '<button type="button" class="runtime-setup-inline-action" data-managed-llama-action="' + name + '"' + (allowed(state, name) ? '' : ' disabled') + '>' + label + '</button>';
  // Display the complete pinned release metadata, including its download size,
  // without treating metadata as HTML or assuming real binary compatibility.
  const release = state.capabilities?.release;
  const metadata = release ? '<details><summary>Release and download size (bytes)</summary><pre>' + escapeHtml(JSON.stringify(release, null, 2)) + '</pre></details>' : '<p class="runtime-setup-feedback">Release size unavailable. Refresh status.</p>';
  const feedback = state.error || (state.busy ? state.busy + '…' : state.status ? 'Engine: ' + state.status.phase + ' · installation: ' + state.status.installation : 'Status not loaded.');
  return choices + '<p class="runtime-setup-feedback">macOS (Apple silicon / Intel), Ubuntu 22.04+ x64 CPU, and Windows 10/11 x64 CPU (local NTFS storage, PowerShell 5.1). Binary compatibility is unverified. Choose an existing local GGUF; no model download is provided. Install downloads only the engine; Start is a separate action. Inspect can restore saved launch settings into unedited fields; explicit Start remains required.</p>' + lifetime + metadata + inputs +
    '<div class="managed-llama-actions"><div class="managed-llama-action-group" role="group" aria-label="Engine status">' + button('refresh', 'Refresh status') + button('inspect', 'Inspect installation') + '</div>' +
    '<div class="managed-llama-action-group" role="group" aria-label="Engine controls">' + button('install', 'Download and install engine') + button('start', 'Start engine') + button('stop', 'Stop engine') + button('cancel', 'Cancel operation') + '</div>' +
    button('use', 'Use this ready engine') + '</div>' +
    '<p class="runtime-setup-feedback' + (state.error ? ' error' : '') + '" role="' + (state.error ? 'alert' : 'status') + '">' + escapeHtml(feedback) + '</p>' +
    (state.retry ? '<button type="button" class="runtime-setup-inline-action" data-managed-llama-action="retry"' + (allowed(state, state.retry) ? '' : ' disabled') + '>Retry ' + escapeHtml(state.retry) + '</button>' : '') +
    (!state.ready && state.status?.ownsProcess ? '<p class="runtime-setup-feedback">A managed engine is running, but this setup does not know its launch settings. Stop it explicitly before starting with these fields, or use a manual connection.</p>' : '');
}
