import { workSessionStatus } from "./conversation.js";

export function createSessionInspector({ client, view, getScope }) {
  let open = null;
  function close() {
    open = null;
    view.session(null);
  }
  async function refresh(detail) {
    const entry = open;
    if (!entry || entry.pending || !detail) return;
    const session = detail.sessions?.find((item) => item.sessionId === entry.id);
    if (!session) { close(); return; }
    const attempt = detail.attempts?.findLast((item) => item.request.sessionId === entry.id);
    const status = workSessionStatus(session.status ? session : attempt);
    // A terminal receipt is immutable. Reused sessions have a new attempt identity.
    const receipt = session.settledAttemptId ?? (attempt?.status === "settled" ? attempt.id : "");
    if (receipt && entry.receipt === receipt) return;
    const label = session.purpose?.trim() || "Work session";
    const show = (value) => view.session({ label, status, ...value });
    if (!entry.loaded) show({ loading: true });
    entry.pending = true;
    try {
      const result = await client.getAgentSession(entry.agent, entry.id, entry.environment);
      if (open !== entry) return;
      entry.loaded = true;
      entry.session = result.session;
      entry.receipt = result.session ? receipt : "";
      show({ session: result.session });
    } catch {
      if (open === entry) show({ session: entry.session, error: "Couldn’t load the latest session history." });
    } finally { entry.pending = false; }
  }
  return {
    close, refresh, active: () => Boolean(open),
    async show(id, detail) {
      const { selected: agent, environment } = getScope();
      open = { id, agent, environment, pending: false, loaded: false, receipt: "" };
      await refresh(detail);
    },
  };
}
