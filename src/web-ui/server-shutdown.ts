import type { Server } from "node:http";
import type { WebSocketServer } from "ws";
import { closeHttpServerImmediately } from "../shared/http-server-shutdown.js";

/** Fence transport and environment intake before waiting for startup or stop. */
export function createWebUiShutdown(
  server: Server,
  webSockets: WebSocketServer,
  startup: Promise<void> | undefined,
  stopBackend: () => Promise<void> | undefined,
  listenAbort: AbortController,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    const wasListening = server.listening;
    const transport = closeHttpServerImmediately(server, webSockets).catch(
      (error: NodeJS.ErrnoException) => {
        if (isPendingListenAlreadyClosed(error, wasListening)) return;
        throw error;
      },
    );
    listenAbort.abort();
    const backend = (async () => {
      await stopBackend();
    })();
    closing = Promise.allSettled([transport, startup, backend]).then(
      (results) => {
        // Preserve transport-close error precedence, then original startup error.
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
        }
      },
    );
    return closing;
  };
}

function isPendingListenAlreadyClosed(
  error: NodeJS.ErrnoException,
  wasListening: boolean,
): boolean {
  if (wasListening) return false;
  return error.code === "ERR_SERVER_NOT_RUNNING";
}
