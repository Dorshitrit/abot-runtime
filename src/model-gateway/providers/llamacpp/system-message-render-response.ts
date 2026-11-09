import { isPlainObject } from "../../structured-output/format-contract.js";

const MAX_RENDER_BYTES = 256 * 1024;
const MAX_RENDER_ERROR_BYTES = 16 * 1024;

async function readRenderJson(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("llamacpp_system_message_render_invalid_response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    signal?.throwIfAborted();
    while (true) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error("llamacpp_system_message_render_response_too_large");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function isTemplateRefusalStatus(status: number): boolean {
  return status === 400 || status === 422;
}

function isJinjaTemplateRefusal(body: unknown): boolean {
  if (!isPlainObject(body) || !isPlainObject(body.error)) return false;
  const error = body.error;
  if (error.code !== 500 || error.type !== "server_error") return false;
  if (typeof error.message !== "string") return false;
  // llama.cpp's raise_exception builtin supplies this engine prefix, regardless of template or model.
  return /(?:^|\n)(?:Error: )?Jinja Exception: /.test(error.message);
}

function requireRenderedPrompt(body: unknown): string {
  if (!isPlainObject(body)) throw new Error("llamacpp_system_message_render_invalid_response");
  if (typeof body.prompt !== "string" || !body.prompt.length) throw new Error("llamacpp_system_message_render_invalid_response");
  return body.prompt;
}

/** Undefined rejects this layout; transport and unrecognized server failures stay fatal. */
export async function readLlamaCppRenderResponse(response: Response, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (response.ok) {
    const body = await readRenderJson(response, MAX_RENDER_BYTES, signal);
    return requireRenderedPrompt(body);
  }
  if (isTemplateRefusalStatus(response.status)) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (response.status !== 500) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`llamacpp_system_message_render_http_${response.status}`);
  }

  const body = await readRenderJson(response, MAX_RENDER_ERROR_BYTES, signal);
  if (isJinjaTemplateRefusal(body)) return undefined;
  throw new Error("llamacpp_system_message_render_http_500");
}
