function createSteerId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `web-steer-${randomId}`;
  return `web-steer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSteerController({
  sendRealtime,
  getScope,
  getPendingAttachmentCount,
  onAccepted,
  timeoutMs = 10_000,
  setTimer = window.setTimeout.bind(window),
  clearTimer = clearTimeout,
}) {
  const pendingSteers = new Map();

  function handleAcknowledgement(message) {
    const steerId = String(message.steerId || "");
    const pending = pendingSteers.get(steerId);
    if (!pending) return false;
    pendingSteers.delete(steerId);
    clearTimer(pending.timeoutId);
    if (String(message.requestId || "") !== pending.requestId) {
      pending.reject(new Error("Steer acknowledgement requestId mismatch."));
      return true;
    }
    if (message.accepted === true) pending.resolve(message);
    else {
      pending.reject(
        new Error(String(message.reason || "Steer was not accepted.")),
      );
    }
    return true;
  }

  function rejectAll(reason) {
    const pending = [...pendingSteers.values()];
    pendingSteers.clear();
    for (const entry of pending) {
      clearTimer(entry.timeoutId);
      entry.reject(new Error(reason));
    }
  }

  async function steer(text) {
    const { requestId, environmentId, sessionId } = getScope();
    if (!requestId || !sessionId) {
      throw new Error("There is no active request to steer.");
    }
    if (getPendingAttachmentCount() > 0) {
      throw new Error("Attachments can only be sent with Send next.");
    }
    const steerId = createSteerId();
    const acknowledgement = new Promise((resolve, reject) => {
      const pending = {
        requestId,
        environmentId,
        sessionId,
        text,
        resolve,
        reject,
        timeoutId: 0,
      };
      pending.timeoutId = setTimer(() => {
        if (pendingSteers.get(steerId) !== pending) return;
        pendingSteers.delete(steerId);
        reject(new Error("Timed out waiting for steer acknowledgement."));
      }, timeoutMs);
      pendingSteers.set(steerId, pending);
    });
    if (
      !sendRealtime({
        type: "steer_request",
        requestId,
        steerId,
        text,
        environment: environmentId,
      })
    ) {
      const pending = pendingSteers.get(steerId);
      pendingSteers.delete(steerId);
      if (pending) clearTimer(pending.timeoutId);
      throw new Error("Realtime connection is not available.");
    }
    await acknowledgement;
    const current = getScope();
    if (
      current.environmentId === environmentId &&
      current.sessionId === sessionId
    ) {
      onAccepted({ steerId, requestId, text });
    }
  }

  return { handleAcknowledgement, rejectAll, steer };
}
