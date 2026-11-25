import { escapeAttribute as attr, escapeHtml as html } from "../../lib/text-format.js";
import { createManagedServerDialog } from "./dialog.js";
import { serverDescription } from "./rendering.js";

/** Connect the normal provider-save flow to a selected managed catalog model. */
export function createManagedServerSetup({ container, state, client, getEnvironmentId, isAvailable, isHostBusy, isForward, modelField, onReady }) {
  const view = { mode: "manual", server: null, alias: "", ready: null, busy: "", error: "" };
  let generation = 0, environment = getEnvironmentId();
  const dialog = createManagedServerDialog({ client, getEnvironmentId, documentRoot: container.ownerDocument,
    onChange(server) { invalidate(); view.server = server; mount(); } });
  function invalidate() { view.ready = null; state.managedLlama = false; delete state.managedLlamaRevision; }
  function reset() {
    generation++; dialog.close(); invalidate();
    Object.assign(view, { mode: "manual", server: null, alias: "", busy: "", error: "" });
    environment = getEnvironmentId();
  }
  function sync() { if (environment !== getEnvironmentId()) reset(); }
  function blocked() {
    sync();
    if (!isAvailable() || view.mode !== "managed") return false;
    if (!state.managedLlama || !view.ready) return true;
    return state[modelField] !== view.ready.model || state.baseUrl !== view.ready.baseUrl || Number(state.contextWindowTokens) !== view.ready.contextWindowTokens;
  }
  function gate() {
    const needsSelection = blocked();
    for (const control of container.querySelectorAll("input, select, button")) {
      if (control.closest("[data-managed-llama-slot]")) continue;
      const locked = Boolean(view.busy) || (needsSelection && isForward(control));
      if (locked && !control.hasAttribute("data-managed-disabled")) {
        control.setAttribute("data-managed-disabled", control.disabled ? "true" : "false"); control.disabled = true; continue;
      }
      if (locked || !control.hasAttribute("data-managed-disabled")) continue;
      control.disabled = control.getAttribute("data-managed-disabled") === "true";
      control.removeAttribute("data-managed-disabled");
    }
  }
  function markup() {
    const choice = `<label class="runtime-setup-field"><span>llama.cpp connection</span><select data-managed-llama-field="mode"><option value="manual"${view.mode === "manual" ? " selected" : ""}>Existing server (manual)</option><option value="managed"${view.mode === "managed" ? " selected" : ""}>ABot-managed server</option></select></label>`;
    if (view.mode !== "managed") return choice;
    const models = view.server?.settings?.models || [];
    return choice + `<p class="runtime-setup-feedback">${html(serverDescription(view.server))}</p>
      <button type="button" class="runtime-setup-inline-action" data-managed-llama-action="manage">Set up / manage local server</button>
      <label class="runtime-setup-field"><span>Chat model</span><select data-managed-llama-field="alias"${view.busy ? " disabled" : ""}><option value="">Choose a configured model</option>${models.map(model => `<option value="${attr(model.alias)}"${view.alias === model.alias ? " selected" : ""}>${html(model.alias)}</option>`).join("")}</select></label>
      <div class="managed-llama-action-group"><button type="button" class="runtime-setup-inline-action" data-managed-llama-action="refresh"${view.busy ? " disabled" : ""}>Refresh status</button><button type="button" class="runtime-setup-inline-action" data-managed-llama-action="use"${view.busy || view.server?.phase !== "ready" || !view.alias ? " disabled" : ""}>Use selected model</button></div>
      <p class="runtime-setup-feedback">The server loads this model when requested. Manage startup and idle sleep here or from the Home card.</p>
      ${view.ready ? '<p class="runtime-setup-feedback">Model selected. Continue to save the connection.</p>' : ""}
      ${view.error ? `<p class="runtime-setup-feedback error" role="alert">${html(view.error)}</p>` : ""}`;
  }
  function mount() {
    sync();
    const slot = container.querySelector("[data-managed-llama-slot]");
    if (slot) { slot.hidden = !isAvailable(); if (!slot.hidden) slot.innerHTML = markup(); }
    gate();
  }
  async function refresh(use = false) {
    const revision = ++generation, env = getEnvironmentId();
    invalidate(); view.busy = "refresh"; view.error = ""; mount();
    try {
      const payload = await client.getManagedLlamaServer(env);
      if (revision !== generation || env !== getEnvironmentId() || view.mode !== "managed") return;
      view.server = payload.server;
      if (!use) return;
      const model = payload.server?.settings?.models.find(model => model.alias === view.alias);
      if (payload.server?.phase !== "ready" || !model || !payload.server.revision) throw new Error("not_ready");
      view.ready = { managedLlama: true, model: model.alias, baseUrl: "http://127.0.0.1:" + payload.server.settings.port,
        contextWindowTokens: model.contextTokens, revision: payload.server.revision };
      Object.assign(state, { managedLlama: true, managedLlamaRevision: view.ready.revision, [modelField]: model.alias,
        baseUrl: view.ready.baseUrl, contextWindowTokens: String(model.contextTokens) });
      onReady(view.ready);
    } catch { if (revision === generation) view.error = "Start the configured server and refresh its status before selecting a model."; }
    finally { if (revision === generation && env === getEnvironmentId()) { view.busy = ""; mount(); } }
  }
  function change(event) {
    const field = event.target.dataset?.managedLlamaField;
    if (!field) return false;
    if (!isAvailable() || isHostBusy()) return true;
    invalidate();
    if (field === "mode") {
      generation++; view.mode = event.target.value; view.busy = "";
      if (view.mode === "managed") void refresh(); else { dialog.close(); mount(); }
    }
    if (field === "alias") { view.alias = event.target.value; mount(); }
    return true;
  }
  function click(event) {
    const action = event.target.closest?.("[data-managed-llama-action]")?.dataset.managedLlamaAction;
    if (!action) return false;
    event.preventDefault();
    if (!isAvailable() || isHostBusy() || view.busy) return true;
    if (action === "manage") void dialog.open();
    if (action === "refresh") void refresh();
    if (action === "use") void refresh(true);
    return true;
  }
  return { binding: { get state() { sync(); return view; }, isBusy: () => Boolean(view.busy) }, invalidate, reset, blocked, gate, mount, change, click };
}
