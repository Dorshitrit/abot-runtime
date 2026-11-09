import { expect, test } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../../types.js";
import { createLlamaCppProviderAdapter } from "./adapter.js";
import { countLlamaCppInputTokens } from "./input-token-count.js";
import { renderLlamaCppTemplate } from "./__tests__/render-template-fixture.js";

type RenderMessage = {
  role: string; content: string; name?: string; tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
};
type Render = (messages: RenderMessage[]) => string;
const call = { callId: "receipt-1", name: "recall_memory", arguments: '{ "query": "private fixture query" }' };
const receipt = { role: "tool", content: "Compact historical result.", toolCallId: call.callId, toolName: call.name };

function fixture(withSystem: boolean) {
  const requestBody: ModelGatewayRequest = {
    modelPolicy: {
      providers: { fixture: { type: "llamacpp", baseUrl: "http://fixture" } },
      profiles: { fixture: { provider: "fixture", model: "local", contextWindowTokens: 4096 } },
      defaults: { profileId: "fixture" },
    },
    modelStep: "supervisor.decision",
    format: { type: "json_schema", name: "decision", schema: { type: "object" } },
    messages: [
      ...(withSystem ? [{ role: "system", content: "Policy." }] : []),
      { role: "user", content: "Skill context." }, { role: "assistant", content: "", toolCalls: [call] },
      receipt, { role: "user", content: "Current task." },
    ],
  };
  let render: Render = renderLlamaCppTemplate;
  const wire: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    wire.push({ path, body });
    if (path === "/apply-template") return Response.json({ prompt: render(body.messages) });
    if (path.endsWith("/input_tokens")) return Response.json({ input_tokens: 55 });
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  const params = { endpoint: "chat" as const, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl };
  return { params, wire, adapter: createLlamaCppProviderAdapter(), setRender(next: Render) { render = next; } };
}

const losses: Record<string, Render> = {
  "missing action": (messages) => renderLlamaCppTemplate(messages.filter((message) => !message.tool_calls)),
  "lost arguments": (messages) => renderLlamaCppTemplate(messages.map((m) => !m.tool_calls ? m : {
    ...m, tool_calls: m.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: "{}" } })),
  })),
  "missing result": (messages) => renderLlamaCppTemplate(messages.filter((message) => message.role !== "tool")),
  "arguments and results flattened into anonymous turns": (messages) => renderLlamaCppTemplate(messages.map((m) => ({
    role: "user", content: m.tool_calls?.map((call) => call.function.arguments).join("\n") ?? m.content,
  }))),
};

test.each([false, true])("rejects tool loss before native counting or dispatch (system header: %s)", async (withSystem) => {
  for (const [loss, render] of Object.entries(losses)) {
    const f = fixture(withSystem);
    f.setRender(render);
    for (const result of [await countLlamaCppInputTokens(f.params), await f.adapter.invoke(f.params)]) {
      expect(result, loss).toMatchObject({ kind: "error", statusCode: 400 });
    }
    expect(f.wire.map(({ path }) => path)).toEqual(["/apply-template", "/apply-template"]);
  }
});

test.each([false, true])("preserves the counted history and detects a later template change (system header: %s)", async (withSystem) => {
  const f = fixture(withSystem);
  // Some templates identify a call by name and its result by call ID alone.
  f.setRender((messages) => messages.map((m) => {
    if (m.tool_calls) return m.tool_calls.map((call) => JSON.stringify({
      id: call.id, arguments: call.function.arguments, name: call.function.name,
    })).join("\n");
    if (m.role === "tool") return JSON.stringify({ id: m.tool_call_id, result: m.content });
    return `[${m.role}]${m.content}`;
  }).join("\n"));
  const counted = await countLlamaCppInputTokens(f.params);
  expect(counted.kind).toBe("counted");
  if (counted.kind !== "counted") throw Error("Expected a native measurement");
  const params = { ...f.params, inputTokenMeasurement: { ...counted, source: "provider_input_token_count" as const } };
  const sent = await f.adapter.invoke(params);
  expect(sent.kind).toBe("chat");
  if (sent.kind === "chat") await sent.stream({ emit() {} });
  expect(f.wire.map(({ path }) => path)).toEqual([
    "/apply-template", "/v1/chat/completions/input_tokens", "/apply-template", "/v1/chat/completions",
  ]);
  expect(f.wire[3]!.body).toEqual(f.wire[1]!.body);
  expect(f.wire[1]!.body.messages).toContainEqual({ role: "assistant", content: "", tool_calls: [
    { id: call.callId, type: "function", function: { name: call.name, arguments: call.arguments } },
  ] });
  expect(f.wire[1]!.body.messages).toContainEqual({
    role: "tool", content: receipt.content, tool_call_id: call.callId, name: call.name,
  });
  expect(f.wire[1]!.body.response_format).toMatchObject({ type: "json_schema" });
  expect(f.wire[1]!.body).not.toHaveProperty("tools");
  f.setRender(losses["missing result"]!);
  expect(await f.adapter.invoke(params)).toMatchObject({ kind: "error", statusCode: 400 });
  expect(f.wire.slice(4).map(({ path }) => path)).toEqual(["/apply-template"]);
});
