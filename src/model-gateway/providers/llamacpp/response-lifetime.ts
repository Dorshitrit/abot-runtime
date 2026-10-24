import { SseDataDecoder } from "../../protocol/sse-data.js";
import { LlamaCppChatStreamNormalizer } from "./stream-normalizer.js";

// End the upstream body before tracing tees it. A native finish chunk precedes
// usage, so only the final marker/error ends transport; the normalizer validates.
export function bindLlamaCppResponseLifetime(response: Response): Response {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const decoder = new SseDataDecoder();
  const normalizer = new LlamaCppChatStreamNormalizer();
  let stopped = false;
  const cancel = (reason?: unknown): void => {
    stopped = true;
    void reader.cancel(reason).catch(() => {});
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) {
          stopped = true;
          controller.close();
          reader.releaseLock();
          return;
        }
        let terminal = false;
        for (const frame of decoder.accept(value)) {
          try { normalizer.consume(frame); }
          catch { terminal = true; break; }
        }
        terminal ||= normalizer.hasTerminated;
        controller.enqueue(value);
        if (terminal) { controller.close(); cancel(); }
      } catch (error) {
        if (stopped) return;
        controller.error(error);
        cancel(error);
      }
    },
    cancel,
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
