import type { Server } from "node:http";
import type { WebSocketServer } from "ws";

/** Stops only this server's connections; active work is not drained on shutdown. */
export function closeHttpServerImmediately(
  server: Server,
  webSockets?: WebSocketServer,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    // Stop accepting first: a connection cannot arrive between the sweep and close.
    server.closeAllConnections();
    webSockets?.close();
    for (const client of webSockets?.clients ?? []) client.terminate();
  });
}
