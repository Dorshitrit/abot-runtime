import { createServer, request as proxyRequest, type Server } from "node:http";
import { onTestFinished } from "vitest";
import { authFixture } from "../../../provider-auth/chatgpt/__tests__/fixture.js";
import { ChatGptAuthService } from "../../../provider-auth/chatgpt/service.js";
import { createRuntimeWebClient } from "../../app/services/runtime-web-client.js";
import type { ChatgptAttempt } from "../../app/services/runtime-web-client/chatgpt-accounts.js";
import { ChatGptWebIntegration } from "../web-integration.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_listener");
  return "http://127.0.0.1:" + address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Real HTTP port publishing with isolated signed OpenID responses and no provider network. */
export async function chatgptWebTransportFixture({
  published = true,
  allowPublishedLoopback = published,
}: { published?: boolean; allowPublishedLoopback?: boolean } = {}) {
  const provider = await authFixture();
  const service = new ChatGptAuthService({
    directory: provider.directory,
    fetchImpl: provider.fetchImpl,
    now: provider.now,
  });
  const integration = new ChatGptWebIntegration({ allowPublishedLoopback }, service);
  const backend = createServer((request, response) => {
    if (published) {
      // Docker changes socket addresses; the original browser Host survives publishing.
      Object.defineProperty(request.socket, "remoteAddress", { value: "172.18.0.1" });
      Object.defineProperty(request.socket, "localAddress", { value: "172.18.0.2" });
    }
    void (async () => {
      const pathname = new URL(request.url!, "http://localhost").pathname;
      if (await integration.handle(request, response, pathname)) return;
      if (pathname.startsWith("/web-api/")) {
        if (await integration.routes.handle(pathname.slice("/web-api/".length), request, response)) return;
      }
      response.writeHead(404);
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end("fixture_handler_failed");
    });
  });
  let frontend: Server | undefined;
  onTestFinished(async () => {
    service.close();
    provider.service.close();
    integration.close();
    if (frontend) await closeServer(frontend);
    await closeServer(backend);
  });
  const backendOrigin = await listen(backend);
  let origin = backendOrigin;
  if (published) {
    frontend = createServer((request, response) => {
      const forwarded = proxyRequest(new URL(request.url!, backendOrigin), {
        method: request.method,
        headers: request.headers,
      }, (incoming) => {
        response.writeHead(incoming.statusCode!, incoming.headers);
        incoming.pipe(response);
      });
      forwarded.on("error", () => { response.writeHead(502); response.end(); });
      request.pipe(forwarded);
    });
    origin = await listen(frontend);
  }
  const client = createRuntimeWebClient({
    getConfig: () => ({ backend: "runtime" }),
    getEnvironmentId: () => "prod",
    origin,
    fetchImpl: (input, init) => fetch(new URL(String(input), origin), {
      ...init,
      headers: { ...init?.headers, origin },
    }),
  });
  async function complete(attempt: ChatgptAttempt, code = "fixture-code") {
    const authorization = new URL(attempt.authorizationUrl!);
    provider.nonce(authorization.searchParams.get("nonce")!);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get("state")!,
      code,
      client_id: "oaiapp_fixture",
    }).toString();
    return fetch(callback, {
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
  }
  return { provider, service, integration, client, origin, backendOrigin, complete };
}
