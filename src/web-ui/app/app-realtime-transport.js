import { createRealtimeTransport } from "./services/realtime-transport.js";

export function createAppRealtimeTransport({
  state,
  getConfig,
  onMessage,
  setConnectionLabel,
  rejectPendingSteers,
  recordControlEvent,
  onConnected,
}) {
  const messageListeners = new Set();
  const connectedListeners = new Set();
  const connectionListeners = new Set();
  const transport = createRealtimeTransport({
    getConfig,
    onMessage: (message) => {
      onMessage(message);
      for (const listener of messageListeners) listener(message);
    },
    onOpen: () => {
      state.connected = true;
      setConnectionLabel("Connected");
      onConnected();
      for (const listener of connectedListeners) listener();
      for (const listener of connectionListeners) listener();
    },
    onClose: () => {
      state.connected = false;
      rejectPendingSteers(
        "Realtime connection closed before steer was accepted.",
      );
      setConnectionLabel("Reconnecting", true);
      for (const listener of connectionListeners) listener();
    },
    onError: () => {
      state.connected = false;
      setConnectionLabel("Connection issue", true);
      for (const listener of connectionListeners) listener();
    },
    onParseError: (error, preview) => {
      recordControlEvent({
        type: "control",
        name: "Realtime parse error",
        tone: "failed",
        summary: `${error instanceof Error ? error.message : String(error)}${
          preview ? `: ${preview}` : ""
        }`,
      });
    },
  });
  return {
    ...transport,
    subscribeMessages(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    subscribeConnectionChanged(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    subscribeConnected(listener) {
      connectedListeners.add(listener);
      return () => connectedListeners.delete(listener);
    },
  };
}
