import { defaultServerSettings, renderServerDialog } from "./rendering.js";

/** Drafts stay local until Save. Closing never stops an engine or retries a write. */
export function createManagedServerDialog({ client, getEnvironmentId, documentRoot = document, onChange = () => {} }) {
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "model-setup-dialog llama-server-dialog";
  dialog.setAttribute("aria-labelledby", "llama-server-title");
  const state = { server: null, draft: defaultServerSettings(), draftRevision: null, dirty: false, busy: "", error: "",
    candidates: [], skipped: [], candidate: { modelPath: "", alias: "", templatePath: "", projectorPath: "" } };
  let environment, generation = 0, actionRevision = 0, timer, renderedServer = "", invoker;
  function current(revision) { return revision === generation && environment === getEnvironmentId() && dialog.open; }
  function render() {
    const focused = dialog.contains(documentRoot.activeElement) ? documentRoot.activeElement : null;
    const focusedAction = focused?.dataset.llamaAction, focusedField = focused?.dataset.llamaField;
    const focusedIndex = focused?.dataset.index;
    const scrollTop = dialog.scrollTop;
    const scrollPositions = [".llama-server-panel", ".runtime-setup-content"].map(selector => [selector, dialog.querySelector(selector)?.scrollTop || 0]);
    const openDetails = new Set([...dialog.querySelectorAll("details[data-llama-section]")].filter(node => node.open).map(node => node.dataset.llamaSection));
    dialog.innerHTML = renderServerDialog(state);
    renderedServer = JSON.stringify(state.server);
    for (const node of dialog.querySelectorAll("details[data-llama-section]")) node.open = openDetails.has(node.dataset.llamaSection);
    dialog.scrollTop = scrollTop;
    for (const [selector, position] of scrollPositions) {
      const node = dialog.querySelector(selector);
      if (node) node.scrollTop = position;
    }
    if (!focused || !dialog.open) return;
    const controls = [...dialog.querySelectorAll("[data-llama-action], [data-llama-field]")];
    const replacement = controls.find(node => !node.disabled &&
      (focusedField ? node.dataset.llamaField === focusedField :
        node.dataset.llamaAction === focusedAction && node.dataset.index === focusedIndex));
    (replacement || dialog.querySelector('[data-llama-action="close"]'))?.focus({ preventScroll: true });
  }
  function observe(server, replaceDraft = false) {
    state.server = server;
    if (replaceDraft || !state.dirty) {
      state.draft = structuredClone(server.settings || defaultServerSettings());
      state.draftRevision = server.revision ?? null;
    }
    if (replaceDraft) state.dirty = false;
    onChange(server);
  }
  function schedule() {
    clearTimeout(timer);
    if (dialog.open) timer = setTimeout(() => { if (!state.busy) void refresh(false); else schedule(); }, 5000);
  }
  async function refresh(visible = true) {
    const revision = generation, operation = actionRevision;
    try {
      const payload = await client.getManagedLlamaServer(environment);
      if (!current(revision) || operation !== actionRevision) return;
      const changed = renderedServer !== JSON.stringify(payload.server);
      observe(payload.server);
      if (visible) state.error = "";
      // Background status updates must not replace a field while it is edited.
      const editing = dialog.contains(documentRoot.activeElement) && ["INPUT", "SELECT", "TEXTAREA"].includes(documentRoot.activeElement?.tagName);
      if (visible || (changed && !editing)) render();
    } catch { if (current(revision) && operation === actionRevision && visible) { state.error = "Server status is unavailable. Refresh before retrying."; render(); } }
    finally { if (current(revision)) schedule(); }
  }
  function add(candidate) {
    if (candidate.kind === "embedding") state.draft.embedding = structuredClone(candidate.model);
    else {
      if (state.draft.models.some(model => model.alias === candidate.model.alias)) throw new Error("duplicate_model");
      state.draft.models.push(structuredClone(candidate.model));
    }
    state.dirty = true;
  }
  async function action(name) {
    if (name === "close") { close(); return; }
    if (state.busy && name !== "stop") return;
    if (name === "refresh") { await refresh(); return; }
    if (name.startsWith("add-candidate:")) {
      try { add(state.candidates[Number(name.split(":")[1])]); state.error = ""; }
      catch { state.error = "A model with this name is already selected."; }
      render(); return;
    }
    const revision = generation, operation = ++actionRevision, request = name === "save" ? "configure" : name;
    const discardsDraft = name === "discard";
    let input = {};
    if (name === "save") input = { settings: structuredClone(state.draft), revision: state.draftRevision };
    if (name === "inspect-model") input = Object.fromEntries(Object.entries(state.candidate).filter(([, value]) => value.trim()));
    state.busy = name;
    state.error = "";
    clearTimeout(timer);
    render();
    try {
      let payload;
      if (name === "stop-legacy") {
        await client.managedLlamaAction("stop", {}, environment);
        if (!current(revision) || operation !== actionRevision) return;
        payload = await client.getManagedLlamaServer(environment);
      } else if (discardsDraft) payload = await client.getManagedLlamaServer(environment);
      else payload = await client.managedLlamaServerAction(request, input, environment);
      if (!current(revision) || operation !== actionRevision) return;
      if (name === "discover") { state.candidates = payload.candidates; state.skipped = payload.skipped; }
      else if (name === "inspect-model") add(payload.candidate);
      else observe(payload.server, name === "save" || discardsDraft);
    } catch (error) {
      if (current(revision) && operation === actionRevision) state.error = "Could not complete this action (" + (error?.code || "request failed") + "). Your draft is retained; refresh status before retrying.";
    } finally {
      if (current(revision) && operation === actionRevision) { state.busy = ""; render(); schedule(); }
    }
  }
  function close({ restoreFocus = true } = {}) {
    generation++; clearTimeout(timer); state.busy = "";
    const previous = invoker;
    invoker = null;
    if (dialog.open) dialog.close();
    if (restoreFocus && previous?.isConnected && !previous.closest("[hidden], [inert]")) previous.focus({ preventScroll: true });
  }
  function isBackdropClick(event) {
    if (event.target !== dialog || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => { if (!dialog.open) close(); });
  dialog.addEventListener("click", event => {
    if (isBackdropClick(event)) { close(); return; }
    const button = event.target.closest("[data-llama-action]");
    if (!button || button.disabled) return;
    if (button.dataset.llamaAction === "remove") {
      const index = button.dataset.index;
      if (index === "embedding") state.draft.embedding = null;
      else state.draft.models.splice(Number(index), 1);
      state.dirty = true; render(); return;
    }
    void action(button.dataset.llamaAction);
  });
  dialog.addEventListener("input", event => {
    const key = event.target.dataset.llamaField;
    if (!key) return;
    const value = event.target.value;
    if (key.startsWith("candidate:")) {
      state.candidate[key.slice(10)] = value;
      const button = dialog.querySelector('[data-llama-action="inspect-model"]');
      if (button) button.disabled = !state.candidate.modelPath || !state.candidate.alias;
      return;
    }
    const parts = key.split(":");
    const target = parts[0] === "embedding" ? state.draft.embedding : parts[0] === "model" ? state.draft.models[Number(parts[1])] : state.draft;
    const field = parts.at(-1);
    target[field] = field === "startup" || (field === "gpuLayers" && value === "auto") ? value : Number(value);
    state.dirty = true;
    const save = dialog.querySelector('[data-llama-action="save"]');
    if (save) save.disabled = !state.draft.models.length || state.server?.installation !== "installed";
    const discard = dialog.querySelector('[data-llama-action="discard"]');
    if (discard) discard.disabled = false;
    const start = dialog.querySelector('[data-llama-action="start"]');
    if (start) start.disabled = true;
  });
  return { close, async open() {
    const next = getEnvironmentId();
    if (environment !== next) { state.dirty = false; state.candidates = []; state.skipped = []; state.draft = defaultServerSettings(); state.draftRevision = null; }
    environment = next; generation++;
    if (!dialog.open) invoker = documentRoot.activeElement;
    if (!dialog.isConnected) documentRoot.body.append(dialog);
    render();
    if (!dialog.open) {
      dialog.showModal();
      dialog.querySelector('[data-llama-action="close"]')?.focus({ preventScroll: true });
    }
    await refresh();
  } };
}
