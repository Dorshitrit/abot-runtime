import WebSocket from "ws";

/** A half-open transport cannot retain host ownership or report connected forever. */
export function monitorHostLiveness(
  socket: WebSocket,
  intervalMs = 15_000,
): void {
  let awaitingPong = false;
  socket.on("pong", () => {
    awaitingPong = false;
  });
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (awaitingPong) {
      socket.terminate();
      return;
    }
    awaitingPong = true;
    socket.ping();
  }, intervalMs);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
}
