export async function decodeRealtimeFrame(data) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

export function createRealtimeTransport({
  getConfig,
  onMessage,
  onOpen,
  onClose,
  onError,
  onParseError,
  reconnectDelayMs = 1_800,
  WebSocketImpl = WebSocket,
  location = window.location,
  scheduleReconnect = setTimeout,
}) {
  let socket = null;

  async function handleFrame(data) {
    let raw = "";
    try {
      raw = await decodeRealtimeFrame(data);
      if (!raw.trim()) return;
      if (raw.trim().startsWith("<")) {
        throw new Error("received non-JSON HTML from realtime proxy");
      }
      onMessage(JSON.parse(raw));
    } catch (error) {
      onParseError(error, raw ? raw.slice(0, 80) : "");
    }
  }

  function connect() {
    const config = getConfig();
    if (!config) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocketImpl(
      `${protocol}//${location.host}${config.realtimePath}`,
    );
    socket.addEventListener("open", () => onOpen());
    socket.addEventListener("message", (event) => void handleFrame(event.data));
    socket.addEventListener("close", () => {
      onClose();
      scheduleReconnect(connect, reconnectDelayMs);
    });
    socket.addEventListener("error", () => onError());
  }

  return {
    connect,
    send(payload) {
      try {
        if (socket?.readyState !== WebSocketImpl.OPEN) return false;
        socket.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    },
  };
}
