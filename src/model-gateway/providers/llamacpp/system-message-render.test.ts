import { expect, test, vi } from "vitest";
import { inspectLlamaCppSystemMessageRender, mergeLeadingLlamaCppSystemMessages } from "./system-message-render.js";
import { renderLlamaCppTemplate } from "./__tests__/render-template-fixture.js";

const url = "https://llama.test/apply-template";
const headers = { "Content-Type": "application/json", Authorization: "Bearer fixture" };
const payload = {
  model: "loaded-model", reasoning_effort: "low", chat_template_kwargs: { enable_thinking: true },
  response_format: { type: "json_schema", json_schema: { name: "private_schema", schema: { const: "private_data" } } },
  messages: [
    { role: "system", content: "private calibration\n" },
    { role: "system", content: "\nprivate role" },
    { role: "user", content: "private task" },
    { role: "assistant", content: "", tool_calls: [
      { id: "private-id-1", type: "function", function: { name: "private_name", arguments: '{"path":"private path"}' } },
      { id: "private-id-2", type: "function", function: { name: "private_name", arguments: '{"path":"private path 2"}' } },
    ] },
    { role: "tool", name: "private_name", tool_call_id: "private-id-1", content: "private result" },
    { role: "tool", name: "private_name", tool_call_id: "private-id-2", content: "private result 2" },
    { role: "system", content: "private repair" },
  ],
};

type ProbeMessage = {
  role: string; content: string; name?: string; tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};

function roleFramedRenderer() {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const { messages } = JSON.parse(String(init?.body)) as { messages: ProbeMessage[] };
    return Response.json({ prompt: renderLlamaCppTemplate(messages) });
  });
}

function fakeRenderer(render: (chunks: string[]) => string) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ProbeMessage[] };
    const chunks = body.messages.flatMap((message) =>
      message.tool_calls?.map((call) => call.function.arguments) ?? [message.content]);
    return Response.json({ prompt: render(chunks) });
  });
}

test("keeps calibration, tool arguments/results, and terminal repair ordered without sending request content", async () => {
  const fetchImpl = roleFramedRenderer();
  const original = structuredClone(payload);
  await expect(inspectLlamaCppSystemMessageRender({ payload, url, headers, fetchImpl })).resolves.toBe("preserved");
  expect(payload).toEqual(original);
  const [target, init] = fetchImpl.mock.calls[0]!;
  expect(target).toBe(url);
  expect(init).toMatchObject({ method: "POST", headers, redirect: "error" });
  expect(init?.body).not.toContain("private");
  const wire = JSON.parse(String(init?.body)) as { messages: ProbeMessage[] };
  expect(wire).toMatchObject({ model: payload.model, reasoning_effort: "low", chat_template_kwargs: { enable_thinking: true } });
  const assistant = wire.messages[3]!;
  expect(assistant.content).toBe("");
  expect(assistant.tool_calls).toHaveLength(2);
  for (const [index, call] of assistant.tool_calls!.entries()) {
    expect(wire.messages[4 + index]).toMatchObject({ role: "tool", tool_call_id: call.id, name: call.function.name });
  }
});

test.each([
  ["omitted second tool call", (parts: string[]) => parts.filter((_, i) => i !== 4).join("|")],
  ["hoisted repair", (parts: string[]) => [parts.at(-1), ...parts.slice(0, -1)].join("|")],
  ["duplicated system", (parts: string[]) => [parts[0], ...parts].join("|")],
])("detects %s", async (_name, render) => {
  const fetchImpl = fakeRenderer(render as (parts: string[]) => string);
  await expect(inspectLlamaCppSystemMessageRender({ payload, url, headers, fetchImpl })).resolves.toBe("incompatible");
});

test("merging keeps both original header markers independently verifiable and preserves late positions", async () => {
  const merged = mergeLeadingLlamaCppSystemMessages(payload.messages);
  expect(merged).toEqual([
    { role: "system", content: "private calibration\n\n\n\nprivate role" }, ...payload.messages.slice(2),
  ]);
  const fetchImpl = roleFramedRenderer();
  await expect(inspectLlamaCppSystemMessageRender({ payload, url, headers, fetchImpl, mergeLeading: true })).resolves.toBe("preserved");
  const losesSecond = fakeRenderer(([head, ...rest]) => [head!.split("\n\n")[0], ...rest].join("|"));
  await expect(inspectLlamaCppSystemMessageRender({
    payload, url, headers, fetchImpl: losesSecond, mergeLeading: true,
  })).resolves.toBe("incompatible");
});

test.each([400, 422])("handles template refusal HTTP %d without consuming upstream error content", async (status) => {
  const fetchImpl = async () => new Response("upstream-sensitive", { status });
  await expect(inspectLlamaCppSystemMessageRender({ payload, url, headers, fetchImpl })).resolves.toBe("incompatible");
});

test.each([
  [() => new Response("upstream-sensitive", { status: 404 }), "http_404"],
  [() => new Response("upstream-sensitive", { status: 503 }), "http_503"],
  [() => new Response("invalid JSON and sensitive upstream report"), "invalid_response"],
  [() => Response.json({ wrongShape: true }), "invalid_response"],
  [() => new Response("x".repeat(256 * 1024 + 1)), "response_too_large"],
  [() => { throw new Error("upstream-sensitive"); }, "unavailable"],
] as const)("fails explicitly on an unavailable or uninspectable render (%s)", async (reply, code) => {
  await expect(inspectLlamaCppSystemMessageRender({
    payload, url, headers, fetchImpl: async () => reply(),
  })).rejects.toThrow(`llamacpp_system_message_render_${code}`);
});

test("respects caller cancellation without contacting the server", async () => {
  const fetchImpl = fakeRenderer((items) => items.join("|"));
  const reason = new Error("caller cancelled");
  await expect(inspectLlamaCppSystemMessageRender({
    payload, url, headers, fetchImpl, signal: AbortSignal.abort(reason),
  })).rejects.toBe(reason);
  expect(fetchImpl).not.toHaveBeenCalled();
});
