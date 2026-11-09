import { expect, test, vi } from "vitest";
import { renderLlamaCppTemplate } from "./__tests__/render-template-fixture.js";
import {
  describeLlamaCppMarkerMismatch,
  type LlamaCppRenderObserver,
} from "./system-message-render-diagnostics.js";
import { inspectLlamaCppSystemMessageRender } from "./system-message-render.js";

const payload = { model: "private-model", messages: [
  { role: "system", content: "private-policy" },
  { role: "user", content: "private-request" },
  { role: "assistant", content: "private-answer" },
  { role: "user", content: "private-followup" },
] };
const nativePayload = { model: "private-model", messages: [
  { role: "system", content: "private-policy" },
  { role: "user", content: "private-request" },
  { role: "assistant", content: "", tool_calls: [
    { id: "private-call", type: "function", function: { name: "private_function", arguments: '{"private":"arguments"}' } },
  ] },
  { role: "tool", tool_call_id: "private-call", name: "private_function", content: "private-result" },
] };

function renderFetch(render: (messages: unknown[]) => string): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
    return Response.json({ prompt: render(body.messages) });
  };
}

function inspect(
  fetchImpl: typeof fetch,
  onDiagnostic: LlamaCppRenderObserver,
  options: { signal?: AbortSignal; payload?: Record<string, unknown> } = {},
) {
  return inspectLlamaCppSystemMessageRender({
    payload, url: "http://fixture/apply-template", headers: {}, fetchImpl, onDiagnostic, ...options,
  });
}

function expectPrivate(observer: ReturnType<typeof vi.fn>) {
  expect(JSON.stringify(observer.mock.calls)).not.toMatch(/private|ABOT[a-f0-9]+X|probe_/);
}

test.each([
  { name: "missing", order: [0, 2, 3], missing: [1], duplicated: [], first: 1 },
  { name: "duplicated", order: [0, 0, 1, 2, 3], missing: [], duplicated: [0], first: 1 },
  { name: "reordered", order: [1, 0, 2, 3], missing: [], duplicated: [], first: 0 },
])("reports $name marker indices without changing incompatibility", async ({ order, missing, duplicated, first }) => {
  const observer = vi.fn();
  const fetchImpl = renderFetch(messages => renderLlamaCppTemplate(order.map(index => messages[index])));
  await expect(inspect(fetchImpl, observer)).resolves.toBe("incompatible");
  expect(observer).toHaveBeenCalledExactlyOnceWith({
    outcome: "incompatible", reason: "marker_mismatch", httpStatus: 200,
    expectedMarkerCount: 4, observedMarkerCount: order.length,
    observedMarkerIndices: order, observedMarkerIndicesOmitted: 0,
    missingMarkerIndices: missing, missingMarkerIndicesOmitted: 0,
    duplicatedMarkerIndices: duplicated, duplicatedMarkerIndicesOmitted: 0,
    unexpectedMarkerCount: 0, firstMismatchPosition: first,
  });
  expectPrivate(observer);
});

test("reports native tool name loss separately from preserved arguments and receipts", async () => {
  const observer = vi.fn();
  const original = structuredClone(nativePayload);
  const fetchImpl = renderFetch(messages => renderLlamaCppTemplate(messages).replaceAll(/probe_[a-f0-9]+/g, ""));
  await expect(inspect(fetchImpl, observer, { payload: nativePayload })).resolves.toBe("incompatible");
  expect(observer).toHaveBeenCalledExactlyOnceWith({
    outcome: "incompatible", reason: "tool_name_missing", httpStatus: 200,
    expectedMarkerCount: 4, observedMarkerCount: 4,
    missingToolNameMarkerIndices: [2], missingToolNameMarkerIndicesOmitted: 0,
  });
  expect(nativePayload).toEqual(original);
  expectPrivate(observer);
});

test.each([false, true])("reports preservation without prompt or function data (native tools: %s)", async (native) => {
  const observer = vi.fn();
  await expect(inspect(renderFetch(renderLlamaCppTemplate), observer, {
    payload: native ? nativePayload : payload,
  })).resolves.toBe("preserved");
  expect(observer).toHaveBeenCalledExactlyOnceWith({
    outcome: "preserved", reason: "preserved", httpStatus: 200,
    expectedMarkerCount: 4, observedMarkerCount: 4,
    ...(native ? { missingToolNameMarkerIndices: [], missingToolNameMarkerIndicesOmitted: 0 } : {}),
  });
  expectPrivate(observer);
});

test.each([400, 422, 500])("reports HTTP %d template refusal without server text", async (status) => {
  const observer = vi.fn();
  const response = Response.json({
    error: { code: status, type: "server_error", message: "Error: Jinja Exception: private-template-detail" },
  }, { status });
  await expect(inspect(async () => response, observer)).resolves.toBe("incompatible");
  expect(observer).toHaveBeenCalledExactlyOnceWith({
    outcome: "incompatible", reason: "template_refused", httpStatus: status,
  });
  expectPrivate(observer);
});

test("keeps an unrecognized upstream failure fatal and excludes its body", async () => {
  const observer = vi.fn();
  const response = Response.json({
    error: { code: 503, type: "server_error", message: "Error: Jinja Exception: private-template-detail" },
  }, { status: 503 });
  await expect(inspect(async () => response, observer)).rejects.toThrow("llamacpp_system_message_render_http_503");
  expect(observer).toHaveBeenCalledExactlyOnceWith({
    outcome: "error", reason: "render_error", httpStatus: 503,
  });
  expectPrivate(observer);
});

test.each([false, true])("preserves caller cancellation during body reading (observer throws: %s)", async (throws) => {
  const caller = new AbortController();
  const reason = new Error("private-cancellation-reason");
  let markReading!: () => void;
  const reading = new Promise<void>(resolve => { markReading = resolve; });
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull() { markReading(); }, cancel,
  }, { highWaterMark: 0 });
  const observer = vi.fn(() => { if (throws) throw new Error("observer failure"); });
  const running = inspect(async () => new Response(body), observer, { signal: caller.signal });
  const rejected = expect(running).rejects.toBe(reason);
  await reading;
  caller.abort(reason);
  await rejected;
  expect(observer).toHaveBeenCalledExactlyOnceWith({
    outcome: "aborted", reason: "aborted", httpStatus: 200,
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  expectPrivate(observer);
});

test.each(["preserved", "incompatible", "error"] as const)(
  "throwing observers cannot replace the %s result",
  async (outcome) => {
    const observer = vi.fn(() => { throw new Error("observer failure"); });
    const fetchImpl = outcome === "error"
      ? async () => new Response(null, { status: 503 })
      : renderFetch(messages => renderLlamaCppTemplate(outcome === "preserved" ? messages : messages.slice(1)));
    const running = inspect(fetchImpl, observer);
    if (outcome === "error") await expect(running).rejects.toThrow("llamacpp_system_message_render_http_503");
    else await expect(running).resolves.toBe(outcome);
    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]).toEqual([expect.objectContaining({ outcome })]);
  },
);

test("bounds marker details while preserving total counts and unknown index positions", () => {
  const markers = Array.from({ length: 300 }, (_, index) => `private-marker-${index}`);
  const observed = [...markers, ...markers, "private-unknown"];
  const diagnostic = describeLlamaCppMarkerMismatch(markers, observed);
  expect(diagnostic).toMatchObject({
    expectedMarkerCount: 300, observedMarkerCount: 601,
    observedMarkerIndices: Array.from({ length: 128 }, (_, index) => index),
    observedMarkerIndicesOmitted: 473,
    missingMarkerIndices: [], missingMarkerIndicesOmitted: 0,
    duplicatedMarkerIndices: Array.from({ length: 128 }, (_, index) => index),
    duplicatedMarkerIndicesOmitted: 172,
    unexpectedMarkerCount: 1, firstMismatchPosition: 300,
  });
  const missing = describeLlamaCppMarkerMismatch(markers, ["private-unknown"]);
  expect(missing).toMatchObject({
    observedMarkerIndices: [-1], missingMarkerIndices: Array.from({ length: 128 }, (_, index) => index),
    missingMarkerIndicesOmitted: 172, unexpectedMarkerCount: 1, firstMismatchPosition: 0,
  });
  expect(JSON.stringify([diagnostic, missing])).not.toContain("private");
});
