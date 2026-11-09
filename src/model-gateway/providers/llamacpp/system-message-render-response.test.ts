import { expect, test, vi } from "vitest";
import { inspectLlamaCppSystemMessageRender } from "./system-message-render.js";

const privateText = "sensitive upstream detail";
const signature = "Jinja Exception: Unsupported message arrangement.";
const payload = { model: "fixture", messages: [
  { role: "system", content: "Policy." },
  { role: "system", content: "Current instruction." },
  { role: "user", content: "Current request." },
] };

function inspect(response: Response, signal?: AbortSignal) {
  return inspectLlamaCppSystemMessageRender({
    payload, signal, url: "http://fixture/apply-template", headers: {},
    fetchImpl: async () => response,
  });
}

function templateError(message: string) {
  return { error: { code: 500, type: "server_error", message } };
}

test.each([
  signature,
  `Error: ${signature}`,
  `\n------------\nWhile executing CallExpression at line 85, column 32 in source:\n...raise_exception(...)\nError: ${signature}`,
  "Error: Jinja Exception: Tool results need a different arrangement.",
])("recognizes engine template refusal independently of its reason (%s)", async (message) => {
  await expect(inspect(Response.json(templateError(message), { status: 500 }))).resolves.toBe("incompatible");
});

test.each([
  ["ordinary server failure", templateError(privateText)],
  ["missing error envelope", { code: 500, type: "server_error", message: signature }],
  ["missing code", { error: { type: "server_error", message: signature } }],
  ["different code", { error: { code: 400, type: "server_error", message: signature } }],
  ["string code", { error: { code: "500", type: "server_error", message: signature } }],
  ["missing type", { error: { code: 500, message: signature } }],
  ["different type", { error: { code: 500, type: "invalid_request_error", message: signature } }],
  ["non-string message", { error: { code: 500, type: "server_error", message: [signature] } }],
  ["signature mentioned in source", templateError(`Source: 'Jinja Exception: ${privateText}'`)],
  ["signature embedded in another error", templateError(`Error: failed to load template containing ${signature}`)],
  ["empty object", {}],
  ["null body", null],
])("keeps %s fatal without exposing the error body", async (_name, body) => {
  await expect(inspect(Response.json(body, { status: 500 }))).rejects.toMatchObject({
    message: "llamacpp_system_message_render_http_500",
  });
});

test.each([401, 403, 404, 503])("does not classify a template-shaped body under HTTP %d", async (status) => {
  await expect(inspect(Response.json(templateError(signature), { status }))).rejects.toMatchObject({
    message: `llamacpp_system_message_render_http_${status}`,
  });
});

test.each([
  ["malformed JSON", () => new Response(`${privateText} {`, { status: 500 })],
  ["missing body", () => new Response(null, { status: 500 })],
] as const)("keeps a %s error response fatal and sanitized", async (_name, response) => {
  await expect(inspect(response())).rejects.toMatchObject({
    message: "llamacpp_system_message_render_invalid_response",
  });
});

test("bounds error bytes while streaming, cancels overflow and releases the reader", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(templateError(`${signature}${"é".repeat(9_000)}`)));
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => { controller.enqueue(bytes); });
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  await expect(inspect(new Response(body, { status: 500 }))).rejects.toMatchObject({
    message: "llamacpp_system_message_render_response_too_large",
  });
  expect(pull).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

test("keeps body-read failures fatal without leaking their upstream reason", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error(privateText)); },
  }, { highWaterMark: 0 });
  await expect(inspect(new Response(body, { status: 500 }))).rejects.toMatchObject({
    message: "llamacpp_system_message_render_unavailable",
  });
  expect(body.locked).toBe(false);
});

test("caller cancellation interrupts a pending error body and preserves its reason", async () => {
  const caller = new AbortController();
  const reason = new Error("caller cancelled the render");
  let markReading!: () => void;
  const reading = new Promise<void>((resolve) => { markReading = resolve; });
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull() { markReading(); },
    cancel,
  }, { highWaterMark: 0 });
  const running = inspect(new Response(body, { status: 500 }), caller.signal);
  const rejected = expect(running).rejects.toBe(reason);
  await reading;
  caller.abort(reason);
  await rejected;
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});


test.each([400, 422])("cancellation during HTTP %d body disposal takes precedence over refusal", async (status) => {
  const caller = new AbortController();
  const reason = new Error("caller cancelled during disposal");
  const body = new ReadableStream<Uint8Array>({
    cancel() { caller.abort(reason); },
  });
  await expect(inspect(new Response(body, { status }), caller.signal)).rejects.toBe(reason);
});
