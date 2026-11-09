import { expect, test, vi } from "vitest";
import { createInputTokenCountHandler } from "../../server/input-token-count-handler.js";
import type { ModelGatewayPolicyConfig } from "../../types.js";
import { renderLlamaCppTemplate } from "./__tests__/render-template-fixture.js";

const modelPolicy: ModelGatewayPolicyConfig = {
  providers: { local: { type: "llamacpp", baseUrl: "http://provider.test" } },
  profiles: { local: { provider: "local", model: "fixture", contextWindowTokens: 1024 } },
  defaults: { profileId: "local" },
};
const request = { messages: [
  { role: "system", content: "One instruction." },
  { role: "system", content: "Another instruction." },
  { role: "user", content: "Answer briefly." },
] };

function startCount(fetchImpl: typeof fetch, signal: AbortSignal) {
  const measurements = { record: vi.fn(), resolve: vi.fn() };
  const response = { setHeader: vi.fn(), write: vi.fn(), end: vi.fn() };
  const handler = createInputTokenCountHandler({ fetchImpl, modelPolicy }, measurements);
  return { running: handler(request, response, { abortSignal: signal }), response, measurements };
}

test("a slow render finishes and counts while the caller's request remains active", async () => {
  vi.useFakeTimers();
  // Node's native AbortSignal.timeout uses an internal timer. Bind it to the same
  // test clock as the slow provider so an accidental shorter probe deadline expires.
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  try {
    const caller = AbortSignal.timeout(30_000);
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/input_tokens")) return Response.json({ input_tokens: 23 });
      const { messages } = JSON.parse(String(init?.body));
      await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
      return Response.json({ prompt: renderLlamaCppTemplate(messages) });
    });
    const { running, response, measurements } = startCount(fetchImpl, caller);

    await vi.advanceTimersByTimeAsync(6_000);
    await running;
    expect(caller.aborted).toBe(false);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://provider.test/apply-template", "http://provider.test/v1/chat/completions/input_tokens",
    ]);
    expect(JSON.parse(response.end.mock.calls[0]![0])).toMatchObject({ inputTokens: 23 });
    expect(measurements.record).toHaveBeenCalledOnce();
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

test("aborting a count while its render body is pending cancels the reader before native counting", async () => {
  const caller = new AbortController();
  let markReading!: () => void;
  const reading = new Promise<void>((resolve) => { markReading = resolve; });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancelBody = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; },
    pull() { markReading(); },
    cancel: cancelBody,
  }, { highWaterMark: 0 });
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body));
  const { running, response, measurements } = startCount(fetchImpl, caller.signal);
  try {
    await reading;
    caller.abort(new Error("count cancelled by caller"));
    expect(cancelBody).toHaveBeenCalledOnce();
    await running;
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["http://provider.test/apply-template"]);
    expect(measurements.record).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  } finally {
    if (!cancelBody.mock.calls.length) stream.close();
    await running;
  }
});
