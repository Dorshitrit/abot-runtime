import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildRuntimeFilesystemScopeMessage } from "../../../runtime/context/runtime-filesystem-scope.js";
import { buildRequestTemporalContextMessage } from "../../../runtime/context/request-temporal-context.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../../../runtime/observability/debug-logger.js";
import { createModelGatewayClient } from "../../client.js";
import { configureModelIoTrace, resetModelIoTraceConfig } from "../../model-io-trace.js";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import { createChatHandler } from "../../server/chat-handler.js";
import type { GatewayResponse } from "../../server/contracts.js";
import { createInputTokenCountHandler } from "../../server/input-token-count-handler.js";
import { createInputTokenMeasurementStore } from "../../server/input-token-measurements.js";
import type { ModelGatewayPolicyConfig, ModelGatewayRequest } from "../../types.js";
import { estimateProviderEnvelopeInputTokens } from "../envelope-budget.js";
import { buildLlamaCppChatPayload } from "./payload.js";
import { renderLlamaCppTemplate, type TemplateMode } from "./__tests__/render-template-fixture.js";

function response(): GatewayResponse & { body: string } {
  return { body: "", setHeader: vi.fn(), write(chunk) { this.body += chunk; },
    end(chunk = "") { this.body += chunk; } };
}
function policy(contextWindowTokens = 128): ModelGatewayPolicyConfig {
  return {
    providers: { local: { type: "llamacpp", baseUrl: "http://provider.test" } },
    profiles: { gemma: { provider: "local", model: "counted-gemma", contextWindowTokens,
      supportsThinking: true, generation: { reasoningBudget: { mode: "tokens", tokens: 123 } },
      calibration: { response: { instructions: ["Stage calibration."] } } } },
    defaults: { profileId: "gemma", steps: { "supervisor.response": "response" } },
  };
}

function createFlow(template: TemplateMode = "all-roles", contextWindowTokens = 128) {
  let render = (messages: { role: string; content: string }[]) => renderLlamaCppTemplate(messages, template);
  let now = 0;
  let measuredCount = 19;
  let lastCountRequest: ModelGatewayRequest = {};
  const wire: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const modelPolicy = policy(contextWindowTokens);
  const measurements = createInputTokenMeasurementStore({ now: () => now });
  const providerFetch = vi.fn<typeof fetch>(async (url, init) => {
    const payload = JSON.parse(String(init?.body));
    wire.push({ url: String(url), payload });
    if (String(url).endsWith("/apply-template")) {
      return Response.json({ prompt: render(payload.messages) });
    }
    if (String(url).endsWith("/input_tokens")) return Response.json({ input_tokens: measuredCount });
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const options = { modelPolicy, fetchImpl: providerFetch };
  const countHandler = createInputTokenCountHandler(options, measurements);
  const chatHandler = createChatHandler(options, measurements);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe("http://gateway.test/input-tokens");
    lastCountRequest = JSON.parse(String(init?.body));
    const output = response();
    await countHandler(lastCountRequest, output, { abortSignal: init?.signal ?? undefined });
    return new Response(output.body, { status: output.statusCode ?? 200 });
  }));
  const client = createModelGatewayClient({ baseUrl: "http://gateway.test" });
  const params = {
    provider: "llamacpp", modelPolicy, debugRequestId: "llamacpp-count-flow",
    agentMode: "deep" as const, modelStep: "supervisor.response" as const,
    messages: [{ role: "user" as const, content: "שלום 🧪 ".repeat(128) }],
    format: { type: "json_schema", name: "answer", schema: {
      type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false,
    } },
    abortSignal: new AbortController().signal,
  };
  return {
    client, params, wire, providerFetch, chatHandler, countHandler, measurements,
    get request() { return lastCountRequest; },
    expire() { now += 5 * 60_000 + 1; },
    setRenderer(next: typeof render) { render = next; },
    setCount(value: number) { measuredCount = value; },
  };
}

// Read the fixture's author/recipient and message body separately, so preserving text alone cannot pass.
function renderedFrames(messages: unknown, template: TemplateMode = "all-roles") {
  const prompt = renderLlamaCppTemplate(messages, template);
  const frame = /<\|start\|>([^<]+)(?:<\|channel\|>[^<]+)?<\|message\|>([\s\S]*?)<\|(?:end|call)\|>/g;
  return Array.from(prompt.matchAll(frame), ([, author, content]) => ({ author, content }));
}

function expectedTextFrames(messages: readonly { role: string; content: string }[]) {
  return messages.map(({ role, content }) => ({ author: role === "system" ? "developer" : role, content }));
}

beforeEach(() => { configureDebugLogger({ enabled: false }); configureModelIoTrace({ enabled: false }); });
afterEach(() => { vi.unstubAllGlobals(); resetDebugLoggerConfig(); resetModelIoTraceConfig(); });

describe("llama.cpp counted admission and final dispatch", () => {
  test("recounts after expiry and refreshes the exact final-envelope measurement", async () => {
    const flow = createFlow();
    expect((await flow.client.countInputTokens(flow.params))?.inputTokens).toBe(19);
    const binding = { requestBody: flow.request, invocation: resolveModelInvocation(flow.request) };
    flow.expire();
    expect(flow.measurements.resolve(binding)).toBeUndefined();
    flow.setCount(29);
    expect((await flow.client.countInputTokens(flow.params))?.inputTokens).toBe(29);
    expect(flow.measurements.resolve(binding)?.inputTokens).toBe(29);
    const output = response();
    await flow.chatHandler(flow.request, output);
    expect(flow.wire.map(({ url }) => url)).toEqual([
      "http://provider.test/v1/chat/completions/input_tokens",
      "http://provider.test/v1/chat/completions/input_tokens",
      "http://provider.test/v1/chat/completions",
    ]);
    expect(flow.wire[2]?.payload).toEqual(flow.wire[1]?.payload);
    expect(estimateProviderEnvelopeInputTokens(flow.wire[2]!.payload)).toBeGreaterThan(128);
    expect(output.body).toContain('"type":"done"');
  });

  test("counts and dispatches every role in order, including a repair after a tool result", async () => {
    const flow = createFlow();
    const policy = { role: "system", content: "Role policy." } as const;
    const reference = { role: "system", content: "Passive reference." } as const;
    const repair = { role: "system", content: "Use the settled tool result." } as const;
    const call = { callId: "read-1", name: "read_file", arguments: ' { "path": "שלום.txt" } ' };
    const receipt = "exact result\n";
    const messages = [
      policy, reference, ...flow.params.messages,
      { role: "assistant", content: "", toolCalls: [call] },
      { role: "tool", content: receipt, toolCallId: call.callId, toolName: call.name },
      repair,
    ] as const;

    expect((await flow.client.countInputTokens({ ...flow.params, messages }))?.inputTokens).toBe(19);
    const output = response();
    await flow.chatHandler(flow.request, output);

    expect(flow.wire.some(({ url }) => url === "http://provider.test/apply-template")).toBe(true);
    const inferenceWire = flow.wire.filter(({ url }) => !url.endsWith("/apply-template"));
    expect(inferenceWire.map(({ url }) => url)).toEqual([
      "http://provider.test/v1/chat/completions/input_tokens",
      "http://provider.test/v1/chat/completions",
    ]);
    const [counted, dispatched] = inferenceWire;
    expect(counted!.payload.messages).toEqual([
      { role: "system", content: "Stage calibration." }, policy, reference, ...flow.params.messages,
      { role: "assistant", content: "", tool_calls: [
        { id: call.callId, type: "function", function: { name: call.name, arguments: call.arguments } },
      ] },
      { role: "tool", name: call.name, tool_call_id: call.callId, content: receipt }, repair,
    ]);
    expect(dispatched!.payload).toEqual(counted!.payload);
    expect(renderedFrames(dispatched!.payload.messages)).toEqual([
      ...expectedTextFrames([{ role: "system", content: "Stage calibration." }, policy, reference, ...flow.params.messages]),
      { author: "assistant to=functions.read_file", content: call.arguments },
      { author: "functions.read_file to=assistant", content: receipt },
      { author: "developer", content: repair.content },
    ]);
    expect(output.body).toContain('"type":"done"');
  });

  test.each(["first-system-only", "all-roles"] as const)(
    "preserves the payload authoring objective, working directory and both user records on %s",
    async (template) => {
      const flow = createFlow(template);
      const instructions = [
        "Return only the requested file content.",
        "The authoringObjective governs this invocation.",
        "Resolve relative paths from the working directory.",
      ];
      const system = instructions.map((content) => ({ role: "system", content }));
      const users = [
        { role: "user", content: "Original request for reference: create a web page with an interactive button." },
        { role: "user", content: JSON.stringify({
          target: "script.js", workingDirectory: "/workspace/site",
          authoringObjective: "Connect the button to the counter.",
          priorWrites: ["index.html", "style.css"],
        }) },
      ];
      const request = { modelStep: "tool_payload.raw", messages: [...system, ...users] };
      const before = structuredClone(request);
      const count = response();
      await flow.countHandler(request, count);
      expect(JSON.parse(count.body).inputTokens).toBe(19);
      const afterCount = flow.wire.length;
      // The counted joined layout remains authoritative even when native now also renders correctly.
      flow.setRenderer((messages) => renderLlamaCppTemplate(messages, "all-roles"));
      const output = response();
      await flow.chatHandler(request, output);

      const probes = flow.wire.filter(({ url }) => url.endsWith("/apply-template"));
      for (const { payload } of probes) {
        expect(JSON.stringify(payload)).not.toContain("script.js");
        expect(JSON.stringify(payload)).not.toContain("authoringObjective");
      }
      const counted = flow.wire.find(({ url }) => url.endsWith("/input_tokens"));
      const generated = flow.wire.slice(afterCount);
      expect(generated.map(({ url }) => url)).toEqual([
        "http://provider.test/apply-template", "http://provider.test/v1/chat/completions",
      ]);
      expect(generated[1]?.payload).toEqual(counted?.payload);
      const expectedSystem = template === "first-system-only"
        ? [{ role: "system", content: instructions.join("\n\n") }] : system;
      expect(counted?.payload.messages).toEqual([...expectedSystem, ...users]);
      const recheckedRoles = (generated[0]!.payload.messages as { role: string }[]).map(({ role }) => role);
      expect(recheckedRoles).toEqual([...expectedSystem, ...users].map(({ role }) => role));
      expect(renderedFrames(generated[1]!.payload.messages)).toEqual(
        expectedTextFrames([...expectedSystem, ...users]),
      );
      expect(request).toEqual(before);
      expect(output.body).toContain('"type":"done"');
    },
  );

  describe("when a template changes under the same model alias", () => {
    const first = { role: "system", content: "Initial instruction." };
    const second = { role: "system", content: "Keep the target binding." };
    const user = { role: "user", content: "Write the file." };
    const leading = { modelStep: "tool_payload.raw", messages: [first, second, user] };
    const interleaved = { modelStep: "supervisor.decision", messages: [first, user, second] };

    async function countedFlow(template: TemplateMode, request: ModelGatewayRequest) {
      const flow = createFlow(template, 4096);
      const output = response();
      await flow.countHandler(request, output);
      expect(JSON.parse(output.body).inputTokens).toBe(19);
      return flow;
    }

    async function expectRejectedLayout(flow: ReturnType<typeof createFlow>, request: ModelGatewayRequest) {
      const before = flow.wire.length;
      const output = response();
      await flow.chatHandler(request, output);
      expect(output.statusCode).toBe(400);
      expect(output.body).toBe("llamacpp_system_message_order_unsupported");
      expect(flow.wire.slice(before).map(({ url }) => url)).toEqual(["http://provider.test/apply-template"]);
    }

    describe.each([
      { layout: "native", template: "all-roles", request: interleaved },
      { layout: "joined", template: "first-system-only", request: leading },
    ] as const)("with a counted $layout layout", ({ template, request }) => {
      test.each([false, true])("rejects lost instructions before dispatch (failed recount: %s)", async (recount) => {
        const flow = await countedFlow(template, request);
        // This template drops later system turns and truncates a merged opening block.
        flow.setRenderer((messages) => renderLlamaCppTemplate(messages.map((m) => ({
          ...m, content: m.role === "system" ? m.content.split("\n\n")[0]! : m.content,
        })), "first-system-only"));
        if (recount) {
          const before = flow.wire.length;
          const output = response();
          await flow.countHandler(request, output);
          expect(output.statusCode).toBe(400);
          expect(output.body).toBe("llamacpp_system_message_order_unsupported");
          expect(flow.wire.slice(before).every(({ url }) => url.endsWith("/apply-template"))).toBe(true);
        }
        await expectRejectedLayout(flow, request);
      });
    });

    test.each(["all-roles", "first-system-only"] as const)(
      "requires a fresh count before dispatching the alternative to the layout counted on %s", async (template) => {
        const flow = await countedFlow(template, leading);
        flow.setRenderer((messages) => {
          if (template === "all-roles") return renderLlamaCppTemplate(messages, "first-system-only");
          return renderLlamaCppTemplate(messages.map((m) => ({ ...m, content: m.content.split("\n\n")[0]! })));
        });
        await expectRejectedLayout(flow, leading);

        const count = response();
        await flow.countHandler(leading, count);
        expect(JSON.parse(count.body).inputTokens).toBe(19);
        const fresh = flow.wire.at(-1)!;
        expect(fresh.url).toBe("http://provider.test/v1/chat/completions/input_tokens");
        const expectedHeader = template === "all-roles"
          ? [{ role: "system", content: [first.content, second.content].join("\n\n") }] : [first, second];
        expect(fresh.payload.messages).toEqual([...expectedHeader, user]);
        const output = response();
        await flow.chatHandler(leading, output);
        expect(output.body).toContain('"type":"done"');
        expect(flow.wire.at(-1)).toEqual({ url: "http://provider.test/v1/chat/completions", payload: fresh.payload });
      },
    );

    test("honors caller cancellation during the dispatch check without generating", async () => {
      const flow = await countedFlow("all-roles", interleaved);
      const caller = new AbortController();
      flow.setRenderer((messages) => { caller.abort(); return renderLlamaCppTemplate(messages); });
      const before = flow.wire.length;
      const output = response();
      await flow.chatHandler(interleaved, output, { abortSignal: caller.signal });
      expect(caller.signal.aborted).toBe(true);
      expect(output.body).toBe("");
      expect(flow.wire.slice(before).map(({ url }) => url)).toEqual(["http://provider.test/apply-template"]);
    });

    test("reports an unavailable dispatch render without generating", async () => {
      const flow = await countedFlow("all-roles", interleaved);
      flow.setRenderer(() => { throw new Error("renderer offline"); });
      const before = flow.wire.length;
      const output = response();
      await flow.chatHandler(interleaved, output);
      expect(output.statusCode).toBe(502);
      expect(output.body).toBe("llamacpp_system_message_render_unavailable");
      expect(flow.wire.slice(before).map(({ url }) => url)).toEqual(["http://provider.test/apply-template"]);
    });
  });

  const clock = buildRequestTemporalContextMessage({ currentDateTime: "2026-11-05 08:00:00 GMT", timeZone: "UTC" });
  const scope = { agentWorkRoot: "/workspace", hostPathSyntax: "posix" } as const;
  const supervisorScope = buildRuntimeFilesystemScopeMessage({ scope, canSelectWorkingDirectory: true })!;
  const workerScope = buildRuntimeFilesystemScopeMessage({
    scope, workingDirectory: "site", capabilities: [{ runtimePathControlIds: ["path"] }],
  })!;
  const prior = { role: "user", content: "Prepare a summary." };
  const current = { role: "user", content: "Schedule it for tomorrow." };
  const delegation = { role: "system", content: "Choose a delegation." };
  const frozenInvocation = { role: "user", content: JSON.stringify({ roleId: "worker", objective: "Build the page." }) };

  describe.each([
    { phase: "delegation after previous user", modelStep: "supervisor.decision",
      messages: [delegation, prior, clock, current] },
    { phase: "delegation after settled turn", modelStep: "supervisor.decision",
      messages: [delegation, prior, { role: "assistant", content: "The summary is ready." }, clock, current] },
    { phase: "supervisor working directory", modelStep: "supervisor.decision",
      messages: [delegation, prior, clock, current, supervisorScope, frozenInvocation] },
    { phase: "first worker decision", modelStep: "worker.decision", messages: [
      { role: "system", content: "Select the next action." }, prior, workerScope, clock,
      { role: "user", content: "Create the page." }, { role: "user", content: "Use the current working directory." },
    ] },
  ])("SUPER $phase", ({ modelStep, messages }) => {
    const request = { modelStep, messages };

    test("counts and dispatches exact role frames for the history, references and user records on a capable renderer", async () => {
      const flow = createFlow("all-roles", 4096);
      const count = response();
      await flow.countHandler(request, count);
      expect(JSON.parse(count.body).inputTokens).toBe(19);
      const chat = response();
      await flow.chatHandler(request, chat);

      const providerCalls = flow.wire.filter(({ url }) => !url.endsWith("/apply-template"));
      expect(providerCalls.map(({ url }) => url)).toEqual([
        "http://provider.test/v1/chat/completions/input_tokens",
        "http://provider.test/v1/chat/completions",
      ]);
      expect(providerCalls[0]?.payload.messages).toEqual(request.messages);
      expect(providerCalls[1]?.payload).toEqual(providerCalls[0]?.payload);
      expect(renderedFrames(providerCalls[1]!.payload.messages)).toEqual(expectedTextFrames(request.messages));
      expect(chat.body).toContain('"type":"done"');
    });

    // A refusal avoids silent clock loss. Successful execution on this renderer remains an acceptance gap.
    test("blocks a lost system reference before count or generation on a first-system-only renderer", async () => {
      const flow = createFlow("first-system-only", 4096);
      for (const handler of [flow.countHandler, flow.chatHandler]) {
        const output = response();
        await handler(request, output);
        expect(output.statusCode).toBe(400);
        expect(output.body).toBe("llamacpp_system_message_order_unsupported");
      }
      expect(flow.wire.length).toBeGreaterThan(0);
      expect(flow.wire.every(({ url }) => url.endsWith("/apply-template"))).toBe(true);
    });
  });

  test("reports an omitted late system repair before native counting or generation", async () => {
    const flow = createFlow("first-system-only");
    const request = {
      modelStep: "tool_payload.raw",
      messages: [
        { role: "system", content: "Return only file content." },
        { role: "user", content: "Write script.js." },
        { role: "assistant", content: "", toolCalls: [
          { callId: "read-1", name: "read_file", arguments: '{"path":"index.html"}' },
        ] },
        { role: "tool", toolCallId: "read-1", toolName: "read_file", content: "A button has id counter." },
        { role: "system", content: "Repair the rejected payload using this result." },
      ],
    };
    for (const handler of [flow.countHandler, flow.chatHandler]) {
      const output = response();
      await handler(request, output);
      expect(output.statusCode).toBe(400);
      expect(output.body).toBe("llamacpp_system_message_order_unsupported");
    }
    expect(flow.wire.length).toBeGreaterThan(0);
    expect(flow.wire.every(({ url }) => url === "http://provider.test/apply-template")).toBe(true);
  });

  test("remeasures changed compaction candidates with their own messages", async () => {
    const flow = createFlow();
    await flow.client.countInputTokens(flow.params);
    const original = flow.request;
    flow.setCount(7);
    const compactedMessages = [{ role: "user" as const, content: "Compacted exact evidence." }];
    expect((await flow.client.countInputTokens({ ...flow.params, messages: compactedMessages }))?.inputTokens).toBe(7);
    expect(flow.wire[0]?.payload.messages).not.toEqual(flow.wire[1]?.payload.messages);
    expect(flow.wire[1]?.payload.messages).toEqual([
      { role: "system", content: "Stage calibration." }, ...compactedMessages,
    ]);
    const invocation = resolveModelInvocation(flow.request);
    expect(flow.measurements.resolve({ requestBody: flow.request, invocation })?.inputTokens).toBe(7);
    expect(flow.measurements.resolve({ requestBody: original, invocation })?.inputTokens).toBe(19);
    const output = response();
    await flow.chatHandler(flow.request, output);
    expect(flow.wire[2]?.payload).toEqual(flow.wire[1]?.payload);
  });

  test.each(["expired", "changed format"])("retains final-guard estimation for %s measurements without claiming an exact match", async (reason) => {
    const flow = createFlow();
    await flow.client.countInputTokens(flow.params);
    let requestBody = flow.request;
    if (reason === "expired") flow.expire();
    if (reason === "changed format") requestBody = { ...requestBody, format: "json" };
    const output = response();
    await flow.chatHandler(requestBody, output);
    expect(flow.wire).toHaveLength(1);
    expect(output.statusCode).toBe(400);
    expect(output.body).toBe("model_context_window_exceeded");
  });

  test("rejects a measured physical overflow before generation", async () => {
    const flow = createFlow();
    flow.setCount(128);
    await flow.client.countInputTokens(flow.params);
    const payload = buildLlamaCppChatPayload({ endpoint: "chat", requestBody: flow.request,
      invocation: resolveModelInvocation(flow.request) });
    expect(flow.measurements.resolve({ requestBody: flow.request, invocation: resolveModelInvocation(flow.request) })?.inputTokens).toBe(128);
    expect(payload.messages).toEqual(flow.wire[0]?.payload.messages);
    const output = response();
    await flow.chatHandler(flow.request, output);
    expect(flow.wire).toHaveLength(1);
    expect(output.body).toBe("model_context_window_exceeded");
  });

  test("propagates cancellation to the active native count without recording a measurement", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal!.addEventListener("abort", () => reject(upstreamSignal!.reason), { once: true });
      });
    });
    const modelPolicy = policy();
    const requestBody: ModelGatewayRequest = { text: "Count only.", modelPolicy };
    const measurements = createInputTokenMeasurementStore();
    const output = response();
    const running = createInputTokenCountHandler({ modelPolicy, fetchImpl }, measurements)(
      requestBody, output, { abortSignal: controller.signal },
    );
    await started;
    controller.abort(new DOMException("count cancelled", "AbortError"));
    await running;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(output.body).toBe("");
    expect(measurements.resolve({ requestBody, invocation: resolveModelInvocation(requestBody) })).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
