import { createManagedServerDialog } from "./dialog.js";
import { managedServerHomeStatus } from "./home-status.js";
import { createConnectionCard } from "../home-connections/card.js";

export function createManagedServerHome({ panel, client, getEnvironmentId, supported, ready, documentRoot = panel.ownerDocument }) {
  let active = false, suspended = false, generation = 0, environment, timer;
  let server = null, unavailable = false, localOnly = false;
  const card = createConnectionCard({ documentRoot, id: "llama", label: "llama.cpp server", icon: "cpu" });
  const { button } = card;
  panel.replaceChildren(button);
  const dialog = createManagedServerDialog({ client, getEnvironmentId, documentRoot,
    onChange(value) {
      generation++;
      server = value; unavailable = false; localOnly = false;
      paint(); schedule();
    },
  });
  function canObserveServer() {
    if (!active || suspended || !supported() || !ready() || !environment) return false;
    return documentRoot.visibilityState !== "hidden";
  }
  function paint() { card.render(managedServerHomeStatus(server, unavailable, localOnly)); }
  function schedule() {
    clearTimeout(timer);
    if (canObserveServer() && !localOnly) timer = setTimeout(read, 10_000);
  }
  async function read() {
    const revision = generation, requestedEnvironment = environment;
    try {
      const payload = await client.getManagedLlamaServer(requestedEnvironment);
      if (revision !== generation || requestedEnvironment !== getEnvironmentId()) return;
      server = payload.server; unavailable = false; localOnly = false;
      paint();
    } catch (error) {
      if (revision !== generation || requestedEnvironment !== getEnvironmentId()) return;
      server = null; unavailable = true; localOnly = error?.status === 403;
      paint();
    } finally {
      if (revision === generation) schedule();
    }
  }
  function sync() {
    generation++; clearTimeout(timer);
    const next = getEnvironmentId();
    if (next !== environment) {
      dialog.close({ restoreFocus: false });
      server = null; unavailable = false; localOnly = false;
    }
    environment = next;
    const visible = active && !suspended && supported() && ready() && Boolean(environment && client?.getManagedLlamaServer);
    panel.hidden = !visible;
    if (!visible) dialog.close({ restoreFocus: false });
    paint();
    if (visible && canObserveServer()) void read();
  }
  button.addEventListener("click", () => { if (canObserveServer() && !button.disabled) void dialog.open(); });
  documentRoot.addEventListener("visibilitychange", sync);
  documentRoot.defaultView?.addEventListener("pagehide", () => { suspended = true; sync(); });
  documentRoot.defaultView?.addEventListener("pageshow", () => { suspended = false; sync(); });
  return { sync, setActive(value) { active = value; sync(); } };
}
