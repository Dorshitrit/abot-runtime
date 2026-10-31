import { createServer, type Server } from "node:http";
import { ChatGptAuthError } from "./contracts.js";
export type ChatGptCallback = { redirectUri: string; close(): void };
export type ChatGptCallbackFactory = (
  consume: (parameters: URLSearchParams) => Promise<void>,
  context: { state: string },
) => Promise<ChatGptCallback>;
export async function createChatGptCallback(
  consume: (parameters: URLSearchParams) => Promise<void>,
): Promise<ChatGptCallback> {
  const server: Server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    const address = server.address();
    const host =
      typeof address === "object" && address ? "127.0.0.1:" + address.port : "";
    if (
      request.method !== "GET" ||
      request.headers.host !== host ||
      (request.url?.length ?? 0) > 8192
    ) {
      response.writeHead(400);
      response.end("Invalid sign-in callback.");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://" + host);
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404);
        response.end();
        return;
      }
      for (const key of url.searchParams.keys())
        if (url.searchParams.getAll(key).length !== 1)
          throw new Error("duplicate_parameter");
      await consume(url.searchParams);
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ChatGPT sign-in completed. Return to ABot.");
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("ChatGPT sign-in did not complete. Return to ABot.");
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string")
    throw new ChatGptAuthError(
      "chatgpt_callback_unavailable",
      "Could not open the local sign-in callback.",
      503,
    );
  return {
    redirectUri: "http://127.0.0.1:" + address.port + "/auth/callback",
    close: () => {
      server.close();
      server.closeIdleConnections();
    },
  };
}
