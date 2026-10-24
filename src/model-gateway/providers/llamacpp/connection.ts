import { resolveLlamaCppUrls } from "./settings.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const CONNECTION_TIMEOUT_MS = 5000;

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`llamacpp_connection_http_${response.status}`);
  if (!response.body) throw new Error("llamacpp_connection_empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("llamacpp_connection_response_too_large");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Explicit read-only connection check; model capabilities remain user declarations. */
export async function inspectLlamaCppConnection(params: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ models: readonly string[] }> {
  const { serverUrl, apiUrl } = resolveLlamaCppUrls(params.baseUrl.trim());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("llamacpp_connection_timeout")), CONNECTION_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`;
  const fetchImpl = params.fetchImpl ?? fetch;
  try {
    const health = await readBoundedJson(await fetchImpl(`${serverUrl}/health`, { headers, signal }));
    if (!record(health) || health.status !== "ok") throw new Error("llamacpp_connection_not_ready");
    const catalog = await readBoundedJson(await fetchImpl(`${apiUrl}/models`, { headers, signal }));
    if (!record(catalog) || !Array.isArray(catalog.data) || catalog.data.length > 128) {
      throw new Error("llamacpp_connection_models_invalid");
    }
    const models = catalog.data.map((entry: unknown) => {
      if (!record(entry) || typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > 512) {
        throw new Error("llamacpp_connection_models_invalid");
      }
      return entry.id;
    });
    if (!models.length) throw new Error("llamacpp_connection_no_models");
    return { models: Object.freeze([...new Set(models)]) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("llamacpp_connection_timeout");
    if (params.signal?.aborted) throw params.signal.reason;
    if (error instanceof Error && /^llamacpp_connection_/.test(error.message)) throw error;
    // Never expose fetched content, credentials or a URL from a network error.
    throw new Error("llamacpp_connection_failed");
  } finally { clearTimeout(timeout); }
}
