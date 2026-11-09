import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { traceDebug } from "../../../runtime/observability/debug-logger.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayRequest } from "../../types.js";
import { createLlamaCppProviderAdapter } from "./adapter.js";
import { renderLlamaCppTemplate } from "./__tests__/render-template-fixture.js";
import { countLlamaCppInputTokens } from "./input-token-count.js";
import type { LlamaCppChatPayload } from "./payload.js";
import { createLlamaCppRenderDiagnostics } from "./system-message-render-diagnostics.js";

vi.mock("../../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));

const diagnosticEvent = "llamacpp.template.inspected";
const serverUrl = "http://private-provider.test";
const secret = "secret-source-content";
const action = { callId: "private-call-id", name: "private_tool_name", arguments: '{"path":"private-tool-argument"}' };
const request: ModelGatewayRequest = {
  debugRequestId: "req-diagnostics", modelStep: "execution.response",
  modelPolicy: {
    providers: { local: { type: "llamacpp", baseUrl: serverUrl, apiKeyEnv: "PACKING_TEST_API_KEY" } },
    profiles: { local: { provider: "local", model: "local", contextWindowTokens: 32768 } },
    defaults: { profileId: "local" },
  },
  messages: [
    { role: "system", content: secret },
    { role: "user", content: "private-user-request" },
    { role: "system", content: "private-clock" },
    { role: "assistant", content: "", toolCalls: [action] },
    { role: "tool", content: "private-tool-result", toolCallId: action.callId, toolName: action.name },
    { role: "system", content: "private-filesystem-scope" },
    { role: "user", content: "private-continuation" },
  ],
  invocationContextMessageIndices: [2, 5],
};
type Mode = "strict" | "first-system-only" | "server-failure";
type WireBody = { messages: Array<{ role: string; content: string }> };
const sourceRoles = ["system", "user", "system", "assistant", "tool", "system", "user"];
const relocatedRoles = ["system", "system", "system", "user", "assistant", "tool", "user"];
const mergedRoles = ["system", "user", "assistant", "tool", "user"];
const layouts = ["original", "context_first", "context_first_merged"];

beforeEach(() => {
  vi.mocked(traceDebug).mockReset();
  vi.stubEnv("PACKING_TEST_API_KEY", "private-bearer-credential");
});
afterEach(() => vi.unstubAllEnvs());

function diagnostics() {
  return vi.mocked(traceDebug).mock.calls
    .filter(([, event]) => event === diagnosticEvent)
    .map(([, , data]) => data as Record<string, unknown>);
}

function fixture(mode: Mode = "strict") {
  const wire: Array<{ url: string; body: WireBody; headers: Headers }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as WireBody;
    wire.push({ url: String(url), body, headers: new Headers(init?.headers) });
    if (String(url).endsWith("/input_tokens")) return Response.json({ input_tokens: 43 });
    if (String(url).endsWith("/chat/completions")) {
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
    expect(String(url)).toBe(serverUrl + "/apply-template");
    if (mode === "server-failure") {
      return Response.json({ error: { code: 500, type: "server_error", message: "private-server-error" } }, { status: 500 });
    }
    if (mode === "strict" && body.messages.some((message, index) => message.role === "system" && index > 0)) {
      return Response.json({ error: {
        code: 500, type: "server_error",
        message: "While executing CallExpression in source:\nError: Jinja Exception: private-template-error",
      } }, { status: 500 });
    }
    return Response.json({ prompt: renderLlamaCppTemplate(body.messages, mode === "first-system-only" ? mode : "all-roles") });
  });
  return {
    wire, fetchImpl,
    params(requestBody: ModelGatewayRequest = request) {
      return { endpoint: "chat" as const, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl };
    },
  };
}

test.each(["strict", "first-system-only"] as const)(
  "records each %s layout and correlates count/send without logging private payloads", async (mode) => {
    const f = fixture(mode);
    const original = structuredClone(request);
    const counted = await countLlamaCppInputTokens(f.params());
    if (counted.kind !== "counted") throw Error("Expected count");
    const countedBody = f.wire.at(-1)!.body;
    const countLogs = diagnostics();
    expect(countLogs).toHaveLength(3);
    expect(countLogs.map(({ layout }) => layout)).toEqual(layouts);
    expect(countLogs.map(({ layoutIndex }) => layoutIndex)).toEqual([1, 2, 3]);
    expect(countLogs.map(({ probeRoles }) => probeRoles)).toEqual([sourceRoles, relocatedRoles, relocatedRoles]);
    expect(countLogs.map(({ wireRoles }) => wireRoles)).toEqual([sourceRoles, relocatedRoles, mergedRoles]);
    expect(countLogs.map(({ probeMarkerCounts }) => probeMarkerCounts)).toEqual(Array(3).fill(Array(7).fill(1)));
    expect(countLogs.map(({ outcome }) => outcome)).toEqual(["incompatible", "incompatible", "preserved"]);
    expect(countLogs.map(({ reason }) => reason)).toEqual([
      mode === "strict" ? "template_refused" : "marker_mismatch",
      mode === "strict" ? "template_refused" : "marker_mismatch", "preserved",
    ]);
    expect(countLogs.map(({ httpStatus }) => httpStatus)).toEqual(mode === "strict" ? [500, 500, 200] : [200, 200, 200]);
    for (const data of countLogs) {
      expect(data).toMatchObject({
        operation: "count", requestId: "req-diagnostics", modelStep: "execution.response",
        profileId: "local", providerId: "local", model: "local", endpoint: "apply-template",
        sourceMessageCount: 7, originalMessageCount: 7, providerMessageOffset: 0,
        sourceRoles, invocationContextMessageIndices: [2, 5], measurementPinned: false,
        sourceRolesOmitted: 0, probeRolesOmitted: 0, wireRolesOmitted: 0, invocationContextIndicesOmitted: 0,
      });
    }
    if (mode === "first-system-only") {
      expect(countLogs[0]).toMatchObject({ expectedMarkerCount: 7, observedMarkerCount: 5, missingMarkerIndices: [2, 5] });
      expect(countLogs[1]).toMatchObject({ expectedMarkerCount: 7, observedMarkerCount: 5, missingMarkerIndices: [1, 2] });
    }
    expect(countLogs[2]).toMatchObject({ expectedMarkerCount: 7, observedMarkerCount: 7, probeMessageCount: 7, wireMessageCount: 5 });
    expect(new Set(countLogs.map(({ packingId }) => packingId)).size).toBe(1);
    expect(countLogs[0]!.packingId).toEqual(expect.any(String));

    const before = f.wire.length;
    const dispatched = await createLlamaCppProviderAdapter().invoke({
      ...f.params(), inputTokenMeasurement: { ...counted, source: "provider_input_token_count" },
    });
    expect(dispatched.kind).toBe("chat");
    if (dispatched.kind === "chat") await dispatched.stream({ emit() {} });
    expect(f.wire.slice(before).map(({ url }) => url)).toEqual([
      serverUrl + "/apply-template", serverUrl + "/v1/chat/completions",
    ]);
    expect(f.wire.at(-1)!.body).toEqual(countedBody);
    expect(request).toEqual(original);
    const invokeLogs = diagnostics().slice(countLogs.length);
    expect(invokeLogs).toHaveLength(3);
    expect(invokeLogs.map(({ layout }) => layout)).toEqual(layouts);
    expect(invokeLogs.map(({ layoutIndex }) => layoutIndex)).toEqual([1, 2, 3]);
    expect(invokeLogs.map(({ outcome, reason, httpStatus }) => ({ outcome, reason, httpStatus }))).toEqual([
      { outcome: "skipped", reason: "measurement_mismatch", httpStatus: undefined },
      { outcome: "skipped", reason: "measurement_mismatch", httpStatus: undefined },
      { outcome: "preserved", reason: "preserved", httpStatus: 200 },
    ]);
    expect(invokeLogs.every(({ operation, measurementPinned }) => operation === "invoke" && measurementPinned === true)).toBe(true);
    expect(new Set(invokeLogs.map(({ packingId }) => packingId)).size).toBe(1);
    expect(invokeLogs[0]!.packingId).not.toBe(countLogs[0]!.packingId);

    expect(f.wire[0]!.headers.get("Authorization")).toBe("Bearer private-bearer-credential");
    const serialized = JSON.stringify(diagnostics());
    for (const privateValue of [
      serverUrl, secret, "private-user-request", "private-clock", "private-tool-result",
      "private-filesystem-scope", "private-continuation", action.callId, action.name,
      "private-tool-argument", "private-bearer-credential", "private-template-error",
    ]) expect(serialized).not.toContain(privateValue);
  },
);

test("maps a two-call assistant frame to six marker ordinals without exposing tool names", async () => {
  const f = fixture();
  const second = { callId: "second-private-call", name: "second_private_tool", arguments: '{"query":"second-private-query"}' };
  const counted = await countLlamaCppInputTokens(f.params({
    ...request, invocationContextMessageIndices: [],
    messages: [
      { role: "system", content: secret }, { role: "user", content: "private-user-request" },
      { role: "assistant", content: "", toolCalls: [action, second] },
      { role: "tool", content: "first-result", toolCallId: action.callId, toolName: action.name },
      { role: "tool", content: "second-result", toolCallId: second.callId, toolName: second.name },
    ],
  }));
  expect(counted.kind).toBe("counted");
  expect(diagnostics()).toEqual([expect.objectContaining({
    layout: "original", probeMessageCount: 5, probeRoles: ["system", "user", "assistant", "tool", "tool"],
    probeMarkerCounts: [1, 1, 2, 1, 1], expectedMarkerCount: 6, observedMarkerCount: 6,
    outcome: "preserved", reason: "preserved",
  })]);
  const serialized = JSON.stringify(diagnostics());
  for (const tool of [action, second]) {
    expect(serialized).not.toContain(tool.name);
    expect(serialized).not.toContain(tool.callId);
    expect(serialized).not.toContain(tool.arguments);
  }
});

test("a measurement mismatch records skipped layouts without sending any requests", async () => {
  const f = fixture();
  const result = await createLlamaCppProviderAdapter().invoke({
    ...f.params(), inputTokenMeasurement: {
      source: "provider_input_token_count", inputTokens: 43, providerEnvelopeFingerprint: "unmatched",
    },
  });
  expect(result).toEqual({ kind: "error", statusCode: 400, message: "llamacpp_system_message_order_unsupported" });
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(diagnostics().map(({ layout, reason }) => ({ layout, reason }))).toEqual(
    layouts.map(layout => ({ layout, reason: "measurement_mismatch" })),
  );
});

test.each(["count", "invoke"] as const)("records %s server failure without enabling fallback", async (operation) => {
  const f = fixture("server-failure");
  const result = operation === "count"
    ? await countLlamaCppInputTokens(f.params()) : await createLlamaCppProviderAdapter().invoke(f.params());
  expect(result).toEqual({ kind: "error", statusCode: 502, message: "llamacpp_system_message_render_unavailable" });
  expect(f.wire).toHaveLength(1);
  expect(diagnostics()).toEqual([expect.objectContaining({
    operation, layout: "original", layoutIndex: 1, outcome: "error", reason: "render_error", httpStatus: 500,
  })]);
  expect(JSON.stringify(diagnostics())).not.toContain("private-server-error");
});

test.each([
  ["count", "strict"], ["invoke", "strict"], ["count", "server-failure"], ["invoke", "server-failure"],
] as const)("a throwing logger preserves %s %s outcome", async (operation, mode) => {
  vi.mocked(traceDebug).mockImplementation((_, event) => {
    if (event === diagnosticEvent) throw Error("logger failed");
  });
  const f = fixture(mode);
  const result = operation === "count"
    ? await countLlamaCppInputTokens(f.params()) : await createLlamaCppProviderAdapter().invoke(f.params());
  if (mode === "server-failure") {
    expect(result).toEqual({ kind: "error", statusCode: 502, message: "llamacpp_system_message_render_unavailable" });
    expect(f.wire).toHaveLength(1);
  } else {
    expect(result.kind).toBe(operation === "count" ? "counted" : "chat");
    expect(f.wire).toHaveLength(4);
    if (result.kind === "chat") await result.stream({ emit() {} });
  }
});

test("bounds shape metadata and preserves caller index coordinates after provider prefixing", () => {
  const f = fixture();
  const source: LlamaCppChatPayload = {
    messages: Array.from({ length: 151 }, () => ({ role: "system", content: secret })),
  };
  source.messages[0]!.role = "private-invalid-role";
  const params = f.params({ ...request, debugRequestId: "unsafe request id", modelStep: "unsafe\nmodel step" });
  const observe = createLlamaCppRenderDiagnostics(params, source, new Set(Array.from({ length: 150 }, (_, i) => i)), 150, "count");
  observe({ kind: "original", payload: source, probePayload: source, mergeLeading: false }, 1)({
    outcome: "preserved", reason: "preserved",
  });
  const [data] = diagnostics();
  expect(data).toMatchObject({
    sourceMessageCount: 151, originalMessageCount: 150, providerMessageOffset: 1,
    sourceRolesOmitted: 23, probeRolesOmitted: 23, wireRolesOmitted: 23, invocationContextIndicesOmitted: 22,
  });
  for (const key of ["sourceRoles", "probeRoles", "wireRoles", "probeMarkerCounts", "invocationContextMessageIndices"]) {
    expect(data![key]).toHaveLength(128);
  }
  expect(data!.invocationContextMessageIndices).toEqual(Array.from({ length: 128 }, (_, i) => i));
  expect((data!.sourceRoles as string[])[0]).toBe("unknown");
  expect(data!.requestId).toBeUndefined();
  expect(data!.modelStep).toBeUndefined();
  expect(JSON.stringify(data)).not.toContain(secret);
  expect(JSON.stringify(data)).not.toContain("private-invalid-role");
});
