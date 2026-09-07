import { once } from "node:events";
import { createServer, get, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createProviderRequestAbortScope } from "../model-gateway/server/provider-fetch.js";
import { closeHttpServerImmediately } from "./http-server-shutdown.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    if (server.listening) await closeHttpServerImmediately(server);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("shutdown closes an unfinished model stream and aborts its provider without touching another server", async () => {
  let providerSignal: AbortSignal | undefined;
  let streamingResponse: ServerResponse | undefined;
  const gateway = createServer((req, res) => {
    const scope = createProviderRequestAbortScope({
      req,
      res,
      endpoint: "raw",
      requestBody: {},
    });
    providerSignal = scope.signal;
    streamingResponse = res;
    res.once("close", scope.dispose);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: still running\n\n");
    // The simulated provider never finishes by itself.
  });
  const gatewayUrl = await listen(gateway);
  const unrelated = createServer((_req, res) => res.end("unrelated is alive"));
  const unrelatedUrl = await listen(unrelated);
  const request = get(gatewayUrl);
  request.on("error", () => undefined);
  cleanups.push(() => {
    request.destroy();
  });
  const [response] = await once(request, "response");
  response.on("error", () => undefined);
  response.resume();

  await closeHttpServerImmediately(gateway);

  await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
  expect(streamingResponse?.writableEnded).toBe(false);
  expect(gateway.listening).toBe(false);
  expect(await (await fetch(unrelatedUrl)).text()).toBe("unrelated is alive");
});

test("shutdown terminates this server's active WebSocket clients without waiting for their close handshake", async () => {
  const server = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (client) => {
      webSockets.emit("connection", client, request);
    });
  });
  const url = await listen(server);
  const client = new WebSocket(url.replace("http:", "ws:"));
  cleanups.push(() => client.terminate());
  cleanups.push(() => {
    webSockets.close();
    for (const connected of webSockets.clients) connected.terminate();
  });
  await once(client, "open");
  expect(webSockets.clients.size).toBe(1);
  const closed = once(client, "close");

  await closeHttpServerImmediately(server, webSockets);
  await closed;

  expect(server.listening).toBe(false);
  expect(client.readyState).toBe(WebSocket.CLOSED);
});
