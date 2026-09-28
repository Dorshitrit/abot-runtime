export function createNotificationPresence({
  getEnvironmentId,
  getSessionId,
  getWorkspace,
  isConnected,
  send,
  documentRoot = document,
  viewport = window,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer;
  let lastPresence = "";
  let bound = false;
  function hasActiveConversation() {
    if (documentRoot.visibilityState !== "visible") return false;
    if (!documentRoot.hasFocus()) return false;
    if (getWorkspace() !== "chat") return false;
    return Boolean(getSessionId());
  }
  function publish(force = false, leaving = false) {
    if (!isConnected()) {
      clearTimer(timer);
      timer = undefined;
      lastPresence = "";
      return;
    }
    const environment = getEnvironmentId();
    if (!environment) return;
    const payload = {
      type: "notification_presence",
      environment,
      sessionId: getSessionId() || "",
      active: leaving ? false : hasActiveConversation(),
    };
    const serialized = JSON.stringify(payload);
    if (!force && serialized === lastPresence) return;
    clearTimer(timer);
    timer = undefined;
    send(payload);
    lastPresence = serialized;
    if (payload.active) timer = setTimer(() => publish(true), 20_000);
  }
  const changed = () => publish();
  const leaving = () => publish(true, true);
  return {
    changed,
    reconnect: () => publish(true),
    bind() {
      if (bound) return;
      bound = true;
      viewport.addEventListener("focus", changed);
      viewport.addEventListener("blur", changed);
      viewport.addEventListener("pagehide", leaving);
      documentRoot.addEventListener("visibilitychange", changed);
      publish();
    },
    dispose() {
      leaving();
      clearTimer(timer);
      viewport.removeEventListener("focus", changed);
      viewport.removeEventListener("blur", changed);
      viewport.removeEventListener("pagehide", leaving);
      documentRoot.removeEventListener("visibilitychange", changed);
      bound = false;
    },
  };
}
