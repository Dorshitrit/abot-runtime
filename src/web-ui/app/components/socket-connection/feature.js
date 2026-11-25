import { createSocketConnectionDialog } from "./dialog.js";
import { socketHomeStatus } from "./home-status.js";
import { createConnectionCard } from "../home-connections/card.js";

export function createSocketConnectionFeature({ panel, client, getEnvironmentId, supported, ready,
  documentRoot = panel.ownerDocument, page = documentRoot.defaultView, intervalMs = 10_000 }) {
  const card = createConnectionCard({ documentRoot, id: "socket", label: "ABot Socket", icon: "network" });
  const { button } = card;
  panel.replaceChildren(button);
  let active = false, suspended = false, watching = false, environment = "", revision = 0;
  let timer, status, unavailable = false, localOnly = false;
  const dialog = createSocketConnectionDialog({ client, getEnvironmentId, supported, documentRoot,
    onChange(value) { revision++; status = value; unavailable = false; localOnly = false; paint(); schedule(); },
  });

  function paint() {
    panel.hidden = !watching;
    if (!watching) return;
    panel.dataset.socketState = unavailable ? "unavailable" : status?.state || "loading";
    card.render(socketHomeStatus(status, unavailable, localOnly));
  }

  function schedule() {
    clearTimeout(timer);
    if (watching && !localOnly) timer = setTimeout(read, intervalMs);
  }

  async function read() {
    if (!watching) return;
    const current = ++revision;
    const id = environment;
    try {
      const { connection } = await client.getSocketConnection(id);
      if (revision !== current || id !== getEnvironmentId()) return;
      if (connection?.localEnvironmentId !== id) throw new Error("invalid_status");
      status = connection;
      unavailable = false;
      localOnly = false;
      dialog.observe(connection);
    } catch (error) {
      if (revision !== current || id !== getEnvironmentId()) return;
      status = null;
      unavailable = true;
      localOnly = error?.status === 403;
    }
    paint();
    schedule();
  }

  function sync() {
    const id = getEnvironmentId();
    const changed = id !== environment;
    if (changed) {
      dialog.close(false);
      environment = id;
      localOnly = false;
      unavailable = false;
      status = null;
    }
    const next = Boolean(active && !suspended && supported() && ready() && id && documentRoot.visibilityState !== "hidden");
    if (next === watching && !changed) return;
    watching = next;
    revision++;
    clearTimeout(timer);
    paint();
    if (watching) void read();
  }

  function pageHidden() { suspended = true; dialog.close(false); sync(); }
  function pageShown() { suspended = false; sync(); }
  button.addEventListener("click", () => { if (watching && !button.disabled) void dialog.open(environment); });
  documentRoot.addEventListener("visibilitychange", sync);
  page?.addEventListener?.("pagehide", pageHidden);
  page?.addEventListener?.("pageshow", pageShown);
  return {
    setActive(value) { active = value; if (!active) dialog.close(false); sync(); },
    sync,
    offerSetup(environmentId) {
      if (suspended || !supported() || environmentId !== getEnvironmentId()) return Promise.resolve(false);
      return dialog.open(environmentId, true);
    },
  };
}
