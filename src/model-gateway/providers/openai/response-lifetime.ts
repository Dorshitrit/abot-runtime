import { OpenAISseDataDecoder } from "./sse-data.js";
import { OpenAIResponsesStreamNormalizer, type OpenAIResponsesStreamOptions } from "./stream-normalizer.js";

function observeResponseFrame(
  data: string,
  normalizer: OpenAIResponsesStreamNormalizer,
): void {
  if (data === "[DONE]") { normalizer.finish(); return; }
  let event: unknown;
  try { event = JSON.parse(data); } catch { return; }
  normalizer.consume(event);
}

// End the one upstream body before tracing tees it. All consumers therefore
// receive the terminal bytes and EOF, even if the provider keeps HTTP open.
export function bindOpenAIResponseLifetime(
  response: Response,
  options: Pick<OpenAIResponsesStreamOptions,
    "functionOutputName" | "requireCompletedResponse" | "assembleCompletedFunctionItems"> = {},
): Response {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  const decoder = new OpenAISseDataDecoder();
  const normalizer = new OpenAIResponsesStreamNormalizer(options);
  let stopped = false;

  const cancelUpstream = (reason?: unknown): void => {
    stopped = true;
    // Cleanup must not make protocol completion wait on transport teardown.
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
        for (const data of decoder.accept(value)) observeResponseFrame(data, normalizer);
        controller.enqueue(value);
        if (!normalizer.hasTerminated) return;
        controller.close();
        cancelUpstream();
      } catch (error) {
        if (stopped) return;
        controller.error(error);
        cancelUpstream(error);
      }
    },
    cancel: cancelUpstream,
  });
  return new Response(body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}
