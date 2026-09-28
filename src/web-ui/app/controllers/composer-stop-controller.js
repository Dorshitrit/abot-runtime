import { waitingRequest } from "../lib/request-lifecycle-view.js";

export function createComposerStopController({
  state,
  selectedEnvironmentId,
  stopRequest,
  updateSendState,
  setMessageStatus,
}) {
  let pendingKey = "";
  const requestId = () =>
    state.activeRequestId || waitingRequest(state)?.requestId || "";
  const currentKey = () =>
    JSON.stringify([
      selectedEnvironmentId(),
      state.currentSessionId,
      requestId(),
    ]);
  const isStopping = () => Boolean(requestId()) && pendingKey === currentKey();

  async function stop() {
    if (!requestId() || isStopping()) return;
    const waiting = waitingRequest(state);
    const scope = {
      environmentId: selectedEnvironmentId(),
      sessionId: state.currentSessionId,
      requestId: requestId(),
      ...(waiting?.wait && waiting.requestId === requestId()
        ? {
            generation: waiting.generation,
            waitId: waiting.wait.waitId,
            revision: waiting.revision,
            commandId: `cancel:${waiting.generation}:${waiting.wait.waitId}`,
          }
        : {}),
    };
    const key = currentKey();
    pendingKey = key;
    updateSendState();
    setMessageStatus("Stopping…", true);
    try {
      const receipt = await stopRequest(scope);
      if (currentKey() !== key) return;
      if (!receipt?.accepted)
        throw new Error(
          receipt?.reason === "request_not_active"
            ? "This request has already ended. Waiting for its final status."
            : "The request could not be stopped. Try again.",
        );
      // Keep the request active until its canonical terminal event arrives.
    } catch (error) {
      if (pendingKey === key) pendingKey = "";
      if (currentKey() === key)
        setMessageStatus(
          error instanceof Error
            ? error.message
            : "Could not stop the request.",
        );
    } finally {
      if (currentKey() === key) updateSendState();
    }
  }
  return { stop, isStopping };
}
