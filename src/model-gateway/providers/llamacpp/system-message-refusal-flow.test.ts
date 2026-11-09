import { expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../../types.js";
import { createLlamaCppProviderAdapter } from "./adapter.js";
import { renderLlamaCppTemplate } from "./__tests__/render-template-fixture.js";
import { countLlamaCppInputTokens } from "./input-token-count.js";

const policy = { role: "system", content: "Current stage policy." };
const scope = { role: "system", content: "Current filesystem scope." };
const clock = { role: "system", content: "Current request clock." };
const prior = { role: "user", content: "Inspect the workspace." };
const current = { role: "user", content: "Continue using those results." };
const action = { callId: "call-1", name: "inspect", arguments: '{"path":"."}' };
const assistant = { role: "assistant", content: "", toolCalls: [action] };
const receipt = { role: "tool", content: "Settled result.", toolCallId: action.callId, toolName: action.name };
const repair = { role: "system", content: "Correct the decision using the preceding result." };
const request: ModelGatewayRequest = {
  modelPolicy: {
    providers: { local: { type: "llamacpp", baseUrl: "http://fixture" } },
    profiles: { local: { provider: "local", model: "local", contextWindowTokens: 32768 } },
    defaults: { profileId: "local" },
  },
  messages: [policy, prior, clock, assistant, receipt, scope, current],
  invocationContextMessageIndices: [2, 5],
};
const wireAssistant = { role: "assistant", content: "", tool_calls: [
  { id: action.callId, type: "function", function: { name: action.name, arguments: action.arguments } },
] };
const wireReceipt = { role: "tool", content: receipt.content, tool_call_id: action.callId, name: action.name };

type RenderMode = "single-opening-system" | "all-roles" | "server-failure";
type WireEnvelope = { messages: Array<{ role: string; content: string }> };

function rejectsSystemPosition(messages: WireEnvelope["messages"]): boolean {
  return messages.some((message, index) => message.role === "system" && index > 0);
}

function templateRefusal(): Response {
  return Response.json({ error: {
    code: 500, type: "server_error",
    message: "While executing CallExpression in source:\nError: Jinja Exception: This layout is not accepted.",
  } }, { status: 500 });
}

function fixture(initialMode: RenderMode = "single-opening-system") {
  let mode = initialMode;
  const wire: Array<{ url: string; body: WireEnvelope }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as WireEnvelope;
    wire.push({ url: String(url), body });
    if (String(url).endsWith("/input_tokens")) return Response.json({ input_tokens: 43 });
    if (String(url).endsWith("/chat/completions")) {
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
    expect(String(url)).toBe("http://fixture/apply-template");
    if (mode === "server-failure") {
      return Response.json({ error: { code: 500, type: "server_error", message: "Model allocation failed." } }, { status: 500 });
    }
    if (mode === "single-opening-system" && rejectsSystemPosition(body.messages)) return templateRefusal();
    return Response.json({ prompt: renderLlamaCppTemplate(body.messages) });
  });
  return {
    wire, fetchImpl,
    setMode(next: RenderMode) { mode = next; },
    params(requestBody: ModelGatewayRequest) {
      return { endpoint: "chat" as const, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl };
    },
  };
}

test("merges consecutive opening instructions after a template evaluation HTTP 500", async () => {
  const f = fixture();
  const opening: ModelGatewayRequest = {
    ...request, messages: [policy, scope, prior, current], invocationContextMessageIndices: [],
  };
  const original = structuredClone(opening);
  const counted = await countLlamaCppInputTokens(f.params(opening));
  expect(counted.kind).toBe("counted");
  expect(f.wire.map(({ url }) => url)).toEqual([
    "http://fixture/apply-template", "http://fixture/apply-template", "http://fixture/v1/chat/completions/input_tokens",
  ]);
  expect(f.wire.at(-1)!.body.messages).toEqual([
    { role: "system", content: `${policy.content}\n\n${scope.content}` }, prior, current,
  ]);
  expect(opening).toEqual(original);
});

test("relocates only marked references after HTTP 500 and sends exactly the counted envelope", async () => {
  const f = fixture();
  const original = structuredClone(request);
  const counted = await countLlamaCppInputTokens(f.params(request));
  expect(counted.kind).toBe("counted");
  if (counted.kind !== "counted") throw Error("Expected a supported layout to be counted");
  const countedBody = f.wire.at(-1)!.body;
  expect(countedBody.messages).toEqual([
    { role: "system", content: [policy, clock, scope].map(({ content }) => content).join("\n\n") },
    prior, wireAssistant, wireReceipt, current,
  ]);
  expect(f.wire.slice(0, -1).map(({ body }) => body.messages.map(({ role }) => role))).toEqual([
    ["system", "user", "system", "assistant", "tool", "system", "user"],
    ["system", "system", "system", "user", "assistant", "tool", "user"],
    ["system", "user", "assistant", "tool", "user"],
  ]);
  expect(countedBody).not.toHaveProperty("invocationContextMessageIndices");
  const before = f.wire.length;
  const dispatched = await createLlamaCppProviderAdapter().invoke({
    ...f.params(request), inputTokenMeasurement: { ...counted, source: "provider_input_token_count" },
  });
  expect(dispatched.kind).toBe("chat");
  if (dispatched.kind === "chat") await dispatched.stream({ emit() {} });
  expect(f.wire.slice(before).map(({ url }) => url)).toEqual([
    "http://fixture/apply-template", "http://fixture/v1/chat/completions",
  ]);
  expect(f.wire.at(-1)!.body).toEqual(countedBody);
  expect(request).toEqual(original);
});

test("does not move an unmarked correction after a tool result to satisfy a rejecting template", async () => {
  const f = fixture();
  const repairing = {
    ...request, messages: [policy, prior, clock, assistant, receipt, repair], invocationContextMessageIndices: [2],
  };
  const original = structuredClone(repairing);
  const counted = await countLlamaCppInputTokens(f.params(repairing));
  expect(counted).toEqual({ kind: "error", statusCode: 400, message: "llamacpp_system_message_order_unsupported" });
  expect(f.wire).toHaveLength(3);
  for (const probe of f.wire) {
    expect(probe.url).toBe("http://fixture/apply-template");
    expect(probe.body.messages.slice(-2).map(({ role }) => role)).toEqual(["tool", "system"]);
  }
  expect(repairing).toEqual(original);
});

test("keeps the original representation when the template accepts every role position", async () => {
  const f = fixture("all-roles");
  const counted = await countLlamaCppInputTokens(f.params(request));
  expect(counted.kind).toBe("counted");
  expect(f.wire).toHaveLength(2);
  expect(f.wire.at(-1)!.body.messages).toEqual([policy, prior, clock, wireAssistant, wireReceipt, scope, current]);
});

test("a template change cannot replace the counted representation with an uncounted valid alternative", async () => {
  const f = fixture("all-roles");
  const counted = await countLlamaCppInputTokens(f.params(request));
  if (counted.kind !== "counted") throw Error("Expected the original representation to be counted");
  f.setMode("single-opening-system");
  const before = f.wire.length;
  const dispatched = await createLlamaCppProviderAdapter().invoke({
    ...f.params(request), inputTokenMeasurement: { ...counted, source: "provider_input_token_count" },
  });
  expect(dispatched).toEqual({ kind: "error", statusCode: 400, message: "llamacpp_system_message_order_unsupported" });
  expect(f.wire.slice(before).map(({ url }) => url)).toEqual(["http://fixture/apply-template"]);
  // A new measurement can select the valid alternative; the old measurement cannot authorize it.
  const recounted = await countLlamaCppInputTokens(f.params(request));
  expect(recounted.kind).toBe("counted");
  expect(f.wire.at(-1)!.body.messages.map(({ role }) => role)).toEqual(["system", "user", "assistant", "tool", "user"]);
});

test.each(["count", "invoke"] as const)("stops %s after one probe on an unrelated server HTTP 500", async (operation) => {
  const f = fixture("server-failure");
  const params = f.params(request);
  const result = operation === "count"
    ? await countLlamaCppInputTokens(params)
    : await createLlamaCppProviderAdapter().invoke(params);
  expect(result).toEqual({ kind: "error", statusCode: 502, message: "llamacpp_system_message_render_unavailable" });
  expect(f.wire.map(({ url }) => url)).toEqual(["http://fixture/apply-template"]);
});
