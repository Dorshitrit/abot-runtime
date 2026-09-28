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
  return createRealtimeTransport({
    getConfig,
    onMessage,
    onOpen: () => {
      state.connected = true;
      setConnectionLabel("Connected");
      onConnected();
    },
    onClose: () => {
      state.connected = false;
      rejectPendingSteers(
        "Realtime connection closed before steer was accepted.",
      );
      setConnectionLabel("Reconnecting", true);
    },
    onError: () => {
      state.connected = false;
      setConnectionLabel("Connection issue", true);
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
}
