import type { Server } from "node:http";

/** Resolve the actual bound address, including when the caller requested port 0. */
export function waitForWebUiListening(
  server: Server,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("listening", listening);
      server.off("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => failed(new Error("web_ui_closed_before_listening"));
    const listening = () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        failed(new Error("web_ui_tcp_address_unavailable"));
        return;
      }
      cleanup();
      const host =
        address.family === "IPv6" ? `[${address.address}]` : address.address;
      resolve(`http://${host}:${address.port}/`);
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    if (server.listening) {
      listening();
      return;
    }
    server.once("listening", listening);
    server.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
