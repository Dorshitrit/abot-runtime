import { dialogIntro, managementNote, readSocketBundle, safeConnectionError } from "./presentation.js";

const markup = `<form novalidate>
  <header><h2 id="socket-connection-title">ABot Socket</h2><button type="button" data-sc="close" aria-label="Close Socket connection settings">×</button></header>
  <p data-sc="intro"></p>
  <div data-sc="import" hidden>
    <div data-sc="json-fields">
      <label>Setup file<input data-sc="file" type="file" accept=".json,application/json"></label>
      <label>Or paste the setup JSON<input data-sc="paste" type="password" autocomplete="off" spellcheck="false" autocapitalize="none"></label>
    </div>
    <div data-sc="manual-fields" hidden>
      <label>Socket URL<input data-sc="server-url" type="url" placeholder="wss://your-server/agent-bridge" autocomplete="off" spellcheck="false" autocapitalize="none" dir="ltr"></label>
      <label>Runtime ID<input data-sc="runtime-id" type="text" autocomplete="off" spellcheck="false" autocapitalize="none" dir="ltr"></label>
      <label>Runtime token<input data-sc="runtime-token" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" dir="ltr"></label>
    </div>
    <button type="button" class="socket-connection-input-mode" data-sc="input-mode">Enter manually</button>
  </div>
  <dl data-sc="identity" hidden><div><dt>Local environment</dt><dd data-sc="local"></dd></div>
    <div><dt>Socket runtime ID</dt><dd data-sc="remote"></dd></div><div><dt>Server</dt><dd data-sc="origin"></dd></div></dl>
  <p data-sc="notice" role="status" aria-live="polite"></p>
  <footer>
    <button type="button" data-sc="reload" hidden>Reload</button>
    <button type="button" data-sc="manage" hidden></button>
    <button type="button" data-sc="replace" hidden>Change connection</button>
    <button type="button" data-sc="forget" hidden>Forget connection</button>
    <button type="button" data-sc="skip" hidden>Skip for now</button><button type="button" data-sc="cancel">Cancel</button>
    <button type="submit" class="primary-button" data-sc="primary" hidden></button>
  </footer></form>`;

export function createSocketConnectionDialog({ documentRoot, client, getEnvironmentId, supported, onChange }) {
  let dialog, fields, session;

  function ensure() {
    if (dialog) return;
    dialog = documentRoot.createElement("dialog");
    dialog.className = "socket-connection-dialog";
    dialog.setAttribute("aria-labelledby", "socket-connection-title");
    dialog.innerHTML = markup;
    documentRoot.body.appendChild(dialog);
    fields = Object.fromEntries(Array.from(dialog.querySelectorAll("[data-sc]"), node => [node.dataset.sc, node]));
    dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener("close", () => { if (!dialog.open) close(); });
    dialog.addEventListener("click", event => {
      if (event.target === dialog) {
        const box = dialog.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dismiss();
      }
      const action = event.target.closest?.("button")?.dataset.sc;
      if (["cancel", "skip", "close"].includes(action)) dismiss();
      else if (!session || session.busy) return;
      else if (action === "reload") void load(session);
      else if (action === "input-mode") switchInputMode(session);
      else if (action === "replace") { clearEntries(); show(session, "import"); fields.file.focus(); }
      else if (action === "forget") { show(session, "forget"); fields.cancel.focus(); }
      else if (action === "manage") void mutate(session, session.status.state === "paused" ? "resume" : "pause");
    });
    dialog.addEventListener("submit", event => {
      event.preventDefault();
      if (!session || session.busy) return;
      if (session.step === "import") void preview(session);
      else if (session.step === "confirm") void mutate(session, "connect");
      else if (session.step === "forget") void mutate(session, "forget");
    });
    fields.file.addEventListener("change", () => { fields.paste.value = ""; });
    fields.paste.addEventListener("input", () => { fields.file.value = ""; });
  }

  function clearEntries() {
    for (const key of ["file", "paste", "server-url", "runtime-id", "runtime-token"]) fields[key].value = "";
  }

  function switchInputMode(s) {
    clearEntries();
    s.bundle = s.preview = null;
    s.manual = !s.manual;
    show(s, "import");
    fields[s.manual ? "server-url" : "file"].focus();
  }

  function current(s) { return s === session && s.environment === getEnvironmentId() && supported(); }

  function show(s, step, notice = "") {
    s.step = step;
    dialog.dataset.step = step;
    const paired = s.status?.source != null;
    const identity = step === "confirm" ? s.preview : s.status;
    fields.intro.textContent = dialogIntro(step, s);
    fields.import.hidden = step !== "import";
    fields["json-fields"].hidden = Boolean(s.manual);
    fields["manual-fields"].hidden = !s.manual;
    fields["input-mode"].textContent = s.manual ? "Use setup file" : "Enter manually";
    fields.identity.hidden = !identity || !["confirm", "manage", "forget"].includes(step);
    fields.local.textContent = identity?.localEnvironmentId || s.environment;
    fields.remote.textContent = identity?.remoteRuntimeId || "";
    fields.origin.textContent = identity?.serverOrigin || "";
    const message = notice || (step === "manage" ? managementNote(s.status) : "");
    if (fields.notice.textContent !== message) fields.notice.textContent = message;
    fields.notice.hidden = !message;
    fields.skip.hidden = !s.onboarding;
    fields.cancel.hidden = s.onboarding;
    fields.cancel.textContent = step === "manage" ? "Close" : "Cancel";
    fields.reload.hidden = step !== "error";
    fields.replace.hidden = !(step === "manage" && paired);
    fields.manage.hidden = fields.forget.hidden = fields.replace.hidden;
    fields.manage.textContent = s.status?.state === "paused" ? "Resume" : "Pause";
    fields.primary.hidden = !["import", "confirm", "forget"].includes(step);
    fields.primary.textContent = { import: "Review connection", confirm: "Connect", forget: "Forget locally" }[step] ?? "";
    for (const k of ["file", "paste", "server-url", "runtime-id", "runtime-token", "input-mode", "primary", "replace", "forget", "manage", "reload"]) fields[k].disabled = s.busy;
    for (const key of ["cancel", "close", "skip"]) fields[key].disabled = Boolean(s.mutating);
    dialog.setAttribute("aria-busy", String(s.busy));
  }

  function dismiss() { if (!session?.mutating) close(); }

  function fail(s, error) {
    s.mutating = false;
    clearEntries();
    s.preview = s.bundle = null;
    s.busy = false;
    show(s, "error", safeConnectionError(error));
    fields.reload.focus();
  }

  async function load(s) {
    clearEntries();
    s.preview = s.bundle = null;
    s.manual = false;
    s.busy = true;
    show(s, "loading");
    try {
      const { connection } = await client.getSocketConnection(s.environment);
      if (!current(s)) return;
      if (connection?.localEnvironmentId !== s.environment || !Number.isSafeInteger(connection.revision)) throw new Error("invalid_status");
      s.status = connection;
      s.busy = false;
      if (s.onboarding && connection.source) { close(); return; }
      show(s, connection.source ? "manage" : "import");
    } catch (error) { if (current(s)) fail(s, error); }
  }

  async function readInputBundle(s) {
    if (s.manual) return {
      runtimeId: fields["runtime-id"].value.trim(),
      agentBridgeUrl: fields["server-url"].value.trim(),
      runtimeToken: fields["runtime-token"].value.trim(),
    };
    const file = fields.file.files?.[0];
    if (file?.size > 16_384) throw new Error("invalid_bundle");
    const raw = file ? await file.text() : fields.paste.value;
    return readSocketBundle(raw);
  }

  async function preview(s) {
    let bundle;
    s.busy = true;
    show(s, "import", "Reading connection details…");
    try {
      bundle = await readInputBundle(s);
      if (!current(s)) return;
    } catch {
      if (current(s)) { s.busy = false; show(s, "import", "Choose a valid runtime connection JSON file or paste its contents."); }
      return;
    }
    clearEntries();
    try {
      const { preview } = await client.previewSocketConnection(bundle, s.environment);
      if (!current(s)) return;
      if (preview?.localEnvironmentId !== s.environment || !preview.remoteRuntimeId || !preview.serverOrigin) throw new Error("invalid_preview");
      s.bundle = bundle;
      s.preview = preview;
      s.busy = false;
      show(s, "confirm");
      fields.primary.focus();
    } catch (error) { if (current(s)) fail(s, error); }
  }

  async function mutate(s, action) {
    s.busy = s.mutating = true;
    show(s, s.step, "Saving connection settings…");
    const input = { expectedRevision: s.status.revision };
    if (action === "connect") Object.assign(input, { bundle: s.bundle, confirmBinding: true });
    s.preview = s.bundle = null;
    try {
      const { connection } = await client.changeSocketConnection(action, input, s.environment);
      if (!current(s)) return;
      if (connection?.localEnvironmentId !== s.environment || !Number.isSafeInteger(connection.revision)) throw new Error("invalid_status");
      onChange(connection);
      close();
    } catch (error) { if (current(s)) fail(s, error); }
  }

  function close(continueSetup = true) {
    const s = session;
    if (!s) return;
    session = null;
    s.preview = s.bundle = null;
    clearEntries();
    if (dialog.open) dialog.close();
    if (s.invoker?.isConnected && !s.invoker.closest("[hidden], [inert]")) s.invoker.focus({ preventScroll: true });
    s.resolve(continueSetup);
  }

  function open(environment, onboarding = false) {
    if (!supported() || environment !== getEnvironmentId()) return Promise.resolve(false);
    if (session?.environment === environment) return session.result;
    close(false);
    ensure();
    const s = { environment, onboarding, invoker: documentRoot.activeElement };
    s.result = new Promise(resolve => { s.resolve = resolve; });
    session = s;
    dialog.showModal();
    fields.close.focus();
    void load(s);
    return s.result;
  }

  function observe(status) {
    if (!session || !current(session) || session.busy || session.step !== "manage") return;
    if (session.status.revision > status.revision || status.localEnvironmentId !== session.environment) return;
    session.status = status;
    show(session, status.source ? "manage" : "import");
  }

  return { open, close, observe };
}
