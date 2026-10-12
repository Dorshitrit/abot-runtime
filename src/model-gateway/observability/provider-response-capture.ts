import { ProviderSseDiagnostics } from "./provider-sse-diagnostics.js";
import { ProviderResponsePrefix } from "./provider-response-prefix.js";
import { ProviderResponseTail } from "./provider-response-tail.js";

/** Reads only the trace clone. Original provider bytes and errors stay untouched. */
export async function captureProviderResponseBody(response: Response, startedAt: number) {
  const headersAfterMs = Math.max(0, Date.now() - startedAt);
  const sse = isEventStreamResponse(response) ? new ProviderSseDiagnostics() : undefined;
  const decoder = new TextDecoder();
  const parts: string[] = [];
  const prefix = new ProviderResponsePrefix();
  const tail = new ProviderResponseTail();
  let bytesReceived = 0;
  let chunkCount = 0;
  let firstChunkAfterMs: number | null = null;
  let lastChunkAfterMs: number | null = null;
  const reader = response.body?.getReader();
  const streamSnapshot = () => ({
    headersAfterMs,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    bytesReceived,
    chunkCount,
    firstChunkAfterMs,
    lastChunkAfterMs,
    ...(sse ? { sse: sse.snapshot() } : {}),
  });
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      const afterMs = Math.max(0, Date.now() - startedAt);
      bytesReceived += value.byteLength;
      chunkCount += 1;
      firstChunkAfterMs ??= afterMs;
      lastChunkAfterMs = afterMs;
      prefix.append(value);
      tail.append(value);
      const text = decoder.decode(value, { stream: true });
      parts.push(text);
      sse?.observe(text, afterMs);
    }
    const finalText = decoder.decode();
    parts.push(finalText);
    sse?.observe(finalText, Math.max(0, Date.now() - startedAt));
    return { outcome: "completed" as const, body: parts.join(""), stream: streamSnapshot() };
  } catch (error) {
    const partialBodyPrefix = prefix.snapshot();
    const partialBody = tail.snapshot();
    return {
      outcome: "failed" as const,
      error,
      partialBodyPrefix: partialBodyPrefix.toString("utf8"),
      partialBodyPrefixBytes: partialBodyPrefix.byteLength,
      partialBodyPrefixTruncated: bytesReceived > partialBodyPrefix.byteLength,
      partialBody: partialBody.toString("utf8"),
      partialBodyBytes: partialBody.byteLength,
      bodyTruncated: bytesReceived > partialBody.byteLength,
      stream: streamSnapshot(),
    };
  } finally {
    reader?.releaseLock();
  }
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
}
