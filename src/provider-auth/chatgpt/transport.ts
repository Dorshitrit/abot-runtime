import {
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  ChatGptAuthError,
} from "./contracts.js";

export function requireOpenAiUrl(value: string, origin: string): URL {
  const url = new URL(value);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new ChatGptAuthError(
      "chatgpt_endpoint_invalid",
      "OpenAI returned an unsupported authentication endpoint.",
      502,
    );
  return url;
}
export class ChatGptTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async request(
    url: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const origin = url.startsWith(CHATGPT_RESOURCE + "/")
      ? "https://api.openai.com"
      : CHATGPT_ISSUER;
    requireOpenAiUrl(url, origin);
    const boundedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: boundedSignal,
      });
    } catch {
      throw new ChatGptAuthError(
        "chatgpt_network_error",
        "Could not reach OpenAI. Try again.",
        503,
      );
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1048576) throw new Error("oversized_response");
          chunks.push(chunk.value);
        }
    } catch {
      await reader?.cancel().catch(() => undefined);
      throw new ChatGptAuthError(
        "chatgpt_response_invalid",
        "OpenAI returned an unsupported response.",
        502,
      );
    } finally {
      reader?.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      throw new ChatGptAuthError(
        "chatgpt_response_invalid",
        "OpenAI returned an unsupported response.",
        502,
      );
    }
    if (!response.ok) {
      const code =
        value && typeof value === "object" && "error" in value
          ? value.error
          : undefined;
      if (code === "invalid_grant")
        throw new ChatGptAuthError(
          "chatgpt_reauth_required",
          "Sign in to this ChatGPT account again.",
          401,
        );
      if (response.status === 401)
        throw new ChatGptAuthError(
          "chatgpt_reauth_required",
          "Sign in to this ChatGPT account again.",
          401,
        );
      throw new ChatGptAuthError(
        "chatgpt_request_failed",
        "OpenAI could not complete this account request.",
        response.status === 429 ? 429 : 502,
      );
    }
    return value;
  }
  form(
    url: string,
    values: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(values).toString(),
      },
      signal,
    );
  }
}
