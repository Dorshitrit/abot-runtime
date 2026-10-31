import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatGptCallbackFactory } from "../../provider-auth/chatgpt/callback.js";
import { ChatGptAuthError } from "../../provider-auth/chatgpt/contracts.js";
import { hasLoopbackRequestAuthority } from "../request-authority.js";

const CALLBACK_PATH = "/auth/callback";
type PublishedCallback = {
  host: string;
  consume: (parameters: URLSearchParams) => Promise<void>;
};

function callbackUnavailable(): ChatGptAuthError {
  return new ChatGptAuthError(
    "chatgpt_callback_unavailable",
    "Could not open the local sign-in callback.",
    503,
  );
}

function hasPlainHttpTransport(request: IncomingMessage): boolean {
  if (!("encrypted" in request.socket)) return true;
  return !request.socket.encrypted;
}

function readPublishedRedirectUri(request: IncomingMessage): string {
  if (!hasLoopbackRequestAuthority(request)) throw callbackUnavailable();
  if (!hasPlainHttpTransport(request)) throw callbackUnavailable();
  const authority = new URL("http://" + request.headers.host);
  const port = authority.port ? ":" + authority.port : "";
  return "http://127.0.0.1" + port + CALLBACK_PATH;
}

function hasUniqueCallbackParameters(parameters: URLSearchParams): boolean {
  for (const key of parameters.keys()) {
    if (parameters.getAll(key).length !== 1) return false;
  }
  return true;
}

function hasExactCallbackTarget(target: string): boolean {
  if (target === CALLBACK_PATH) return true;
  return target.startsWith(CALLBACK_PATH + "?");
}

function readCallbackParameters(request: IncomingMessage): URLSearchParams {
  if (request.method !== "GET") throw callbackUnavailable();
  if (!hasPlainHttpTransport(request)) throw callbackUnavailable();
  if (!hasLoopbackRequestAuthority(request)) throw callbackUnavailable();
  const target = request.url ?? "";
  if (target.length > 8192) throw callbackUnavailable();
  if (!hasExactCallbackTarget(target)) throw callbackUnavailable();
  const url = new URL(target, "http://" + request.headers.host);
  if (url.hash) throw callbackUnavailable();
  if (!hasUniqueCallbackParameters(url.searchParams)) throw callbackUnavailable();
  return url.searchParams;
}

function matchesPublishedCallbackHost(
  request: IncomingMessage,
  callback: PublishedCallback | undefined,
): callback is PublishedCallback {
  if (!callback) return false;
  return request.headers.host === callback.host;
}

function setCallbackResponseHeaders(response: ServerResponse): void {
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
}

/** Owned by a Web UI listener whose deployment explicitly trusts loopback publication. */
export class ChatGptPublishedCallbacks {
  private readonly callbacks = new Map<string, PublishedCallback>();
  private closed = false;

  factory(request: IncomingMessage): ChatGptCallbackFactory {
    if (this.closed) throw callbackUnavailable();
    const redirectUri = readPublishedRedirectUri(request);
    return async (consume, context) => {
      if (this.closed) throw callbackUnavailable();
      if (this.callbacks.has(context.state)) throw callbackUnavailable();
      const callback = { host: new URL(redirectUri).host, consume };
      this.callbacks.set(context.state, callback);
      return {
        redirectUri,
        close: () => {
          if (this.callbacks.get(context.state) !== callback) return;
          this.callbacks.delete(context.state);
        },
      };
    };
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (pathname !== CALLBACK_PATH) return false;
    setCallbackResponseHeaders(response);
    try {
      const parameters = readCallbackParameters(request);
      const state = parameters.get("state") ?? "";
      const callback = this.callbacks.get(state);
      if (!matchesPublishedCallbackHost(request, callback)) throw callbackUnavailable();
      this.callbacks.delete(state);
      await callback.consume(parameters);
      response.writeHead(200);
      response.end("ChatGPT sign-in completed. Return to ABot.");
    } catch {
      response.writeHead(400);
      response.end("ChatGPT sign-in did not complete. Return to ABot.");
    }
    return true;
  }

  close(): void {
    this.closed = true;
    this.callbacks.clear();
  }
}
