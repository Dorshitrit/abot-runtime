import { expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../../types.js";
import { createLlamaCppProviderAdapter } from "./adapter.js";
import { renderLlamaCppTemplate, type TemplateMode } from "./__tests__/render-template-fixture.js";
import { countLlamaCppInputTokens } from "./input-token-count.js";

const policy = { role: "system", content: "Current stage policy." };
const prior = { role: "user", content: "Set a reminder." };
const scope = { role: "system", content: "{\"scope\":\"current directory\"}" };
const clock = { role: "system", content: "{\"clock\":\"request clock\"}" };
const current = { role: "user", content: "Use tomorrow's date." };
const action = { callId: "id-1", name: "lookup", arguments: '{"query":"test"}' };
const assistant = { role: "assistant", content: "", toolCalls: [action] };
const tool = { role: "tool", content: "Settled receipt.", toolCallId: action.callId, toolName: action.name };
const repair = { role: "system", content: "Return the corrected decision." };
const messages = [policy, prior, scope, assistant, tool, clock, current];
const request: ModelGatewayRequest = {
  modelPolicy: {
    providers: { local: { type: "llamacpp", baseUrl: "http://fixture" } },
    profiles: { local: { provider: "local", model: "local", contextWindowTokens: 32768,
      calibration: { decision: { instructions: ["Configured calibration."] } } } },
    defaults: { profileId: "local", steps: { "supervisor.decision": "decision" } },
  },
  modelStep: "supervisor.decision",
  messages,
  invocationContextMessageIndices: [5, 2],
};

type FixtureMode = TemplateMode | "leading-systems" | "single-leading-system";
type FixtureMessage = { role: string; content: string };
function fixture(template: FixtureMode = "first-system-only") {
  let mode = template;
  let truncateHeader = false;
  const wire: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    wire.push({ url: String(url), body });
    if (String(url).endsWith("/apply-template")) {
      const source = body.messages as FixtureMessage[];
      const firstTurn = source.findIndex((message) => message.role !== "system");
      if (mode === "single-leading-system" && source[1]?.role === "system") return new Response(null, { status: 422 });
      const rendered = mode === "leading-systems" ? source.filter(
        (message, index) => message.role !== "system" || firstTurn < 0 || index < firstTurn,
      ) : source;
      const prompt = renderLlamaCppTemplate(rendered, mode === "first-system-only" ? mode : "all-roles");
      return Response.json({ prompt: truncateHeader ? prompt.replace(/\n\nABOT\w+?Z/, "") : prompt });
    }
    if (String(url).endsWith("/input_tokens")) return Response.json({ input_tokens: 43 });
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  function params(requestBody: ModelGatewayRequest) {
    return { endpoint: "chat" as const, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl };
  }
  return {
    wire, fetchImpl, params,
    setMode(next: TemplateMode) { mode = next; },
    truncate() { truncateHeader = true; },
  };
}

const wireAssistant = { role: "assistant", content: "", tool_calls: [
  { id: action.callId, type: "function", function: { name: action.name, arguments: action.arguments } },
] };
const wireTool = { role: "tool", content: tool.content, tool_call_id: action.callId, name: action.name };
const calibration = { role: "system", content: "Configured calibration." };

test.each(["first-system-only", "all-roles"] as const)(
  "counts the selected layout, rechecks only that layout and dispatches its exact envelope on %s", async (mode) => {
    const f = fixture(mode);
    const original = structuredClone(request);
    const counted = await countLlamaCppInputTokens(f.params(request));
    expect(counted.kind).toBe("counted");
    if (counted.kind !== "counted") throw Error("Expected the selected layout to be counted");
    const { body } = f.wire.at(-1)!;
    const expectedMessages = mode === "all-roles"
      ? [calibration, policy, prior, scope, wireAssistant, wireTool, clock, current]
      : [{ role: "system", content: [calibration, policy, scope, clock].map((m) => m.content).join("\n\n") },
          prior, wireAssistant, wireTool, current];
    expect(body.messages).toEqual(expectedMessages);
    expect(body).not.toHaveProperty("invocationContextMessageIndices");

    const beforeDispatch = f.wire.length;
    f.setMode("all-roles");
    const result = await createLlamaCppProviderAdapter().invoke({
      ...f.params(request), inputTokenMeasurement: { ...counted, source: "provider_input_token_count" },
    });
    expect(result.kind).toBe("chat");
    if (result.kind === "chat") await result.stream({ emit() {} });
    expect(f.wire.slice(beforeDispatch).map((entry) => entry.url)).toEqual([
      "http://fixture/apply-template", "http://fixture/v1/chat/completions",
    ]);
    expect(f.wire.at(-1)!.body).toEqual(body);
    expect(request).toEqual(original);
  },
);

test("keeps separate system frames when the server accepts them throughout the relocated header", async () => {
  const f = fixture("leading-systems");
  const count = await countLlamaCppInputTokens(f.params(request));
  expect(count.kind).toBe("counted");
  expect(f.wire.at(-1)!.body.messages).toEqual([
    calibration, policy, scope, clock, prior, wireAssistant, wireTool, current,
  ]);
});

test("preserves canonical order if merging only the opening instructions is sufficient", async () => {
  const f = fixture("single-leading-system");
  const count = await countLlamaCppInputTokens(f.params(request));
  expect(count.kind).toBe("counted");
  expect(f.wire.at(-1)!.body.messages).toEqual([
    { role: "system", content: [calibration.content, policy.content].join("\n\n") },
    prior, scope, wireAssistant, wireTool, clock, current,
  ]);
});

test("requires every marked header component again on measured dispatch", async () => {
  const f = fixture();
  const measured = await countLlamaCppInputTokens(f.params(request));
  if (measured.kind !== "counted") throw Error("Expected the joined layout to be counted");
  const before = f.wire.length;
  f.truncate();
  const result = await createLlamaCppProviderAdapter().invoke({
    ...f.params(request), inputTokenMeasurement: { ...measured, source: "provider_input_token_count" },
  });
  expect(result).toMatchObject({ kind: "error", statusCode: 400 });
  expect(f.wire.slice(before).map((entry) => entry.url)).toEqual(["http://fixture/apply-template"]);
});

test("a matching body cannot authorize an unmarked system message to move", async () => {
  const f = fixture();
  const twin = { ...clock };
  const result = await countLlamaCppInputTokens(f.params({
    ...request, messages: [policy, prior, clock, { role: "assistant", content: "Earlier." }, twin, current],
    invocationContextMessageIndices: [2],
  }));
  expect(result).toMatchObject({ kind: "error", message: "llamacpp_system_message_order_unsupported" });
  expect(f.wire.every(({ url }) => url.endsWith("/apply-template"))).toBe(true);
});

test("a marked reference cannot move an unmarked correction following a tool receipt", async () => {
  const f = fixture();
  const counted = await countLlamaCppInputTokens(f.params({ ...request, messages: [...messages, repair] }));
  expect(counted).toMatchObject({ kind: "error", message: "llamacpp_system_message_order_unsupported" });
  expect(f.wire.every(({ url }) => url.endsWith("/apply-template"))).toBe(true);
});

test("rejects a marker on a system message with attachments", async () => {
  const f = fixture();
  const result = await countLlamaCppInputTokens(f.params({
    ...request, messages: [{ ...policy, attachments: [{ id: "image", kind: "image", mimeType: "image/png", storageRef: "image" }] }],
    invocationContextMessageIndices: [0],
  }));
  expect(result).toMatchObject({ kind: "error", message: "llamacpp_invocation_context_indices_invalid" });
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

test("an unmatched measured fingerprint cannot silently select another layout", async () => {
  const f = fixture();
  const result = await createLlamaCppProviderAdapter().invoke({
    ...f.params(request), inputTokenMeasurement: {
      source: "provider_input_token_count", inputTokens: 43, providerEnvelopeFingerprint: "obsolete",
    },
  });
  expect(result).toMatchObject({ kind: "error", message: "llamacpp_system_message_order_unsupported" });
  expect(f.fetchImpl).not.toHaveBeenCalled();
});

test.each([[1], [3], [4], [-1], [42], [1.5], [2, 2]])(
  "rejects invalid sidecar %j before contacting the renderer", async (...indices) => {
    const f = fixture();
    const result = await countLlamaCppInputTokens(f.params({ ...request, invocationContextMessageIndices: indices }));
    expect(result).toMatchObject({ kind: "error", message: "llamacpp_invocation_context_indices_invalid" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  },
);
