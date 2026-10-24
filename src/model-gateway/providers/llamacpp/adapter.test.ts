import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createChatHandler, createRawHandler, type GatewayResponse,
} from "../../server.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../../../runtime/observability/debug-logger.js";
import { configureModelIoTrace, resetModelIoTraceConfig } from "../../model-io-trace.js";
import type { ModelGatewayPolicyConfig, ModelGatewayRequest } from "../../types.js";
import { createBuiltInModelProviderAdapterRegistry } from "../registry.js";

function response(): GatewayResponse & { body: string } {
  return { body: "", setHeader: vi.fn(), write(chunk) { this.body += chunk; }, end(chunk = "") { this.body += chunk; } };
}
function policy(baseUrl: string): ModelGatewayPolicyConfig {
  return {
    providers: { local: { type: "llamacpp", baseUrl } },
    profiles: { gemma: { provider: "local", model: "fixture-gemma", contextWindowTokens: 32768,
      supportsThinking: true, generation: { reasoningBudget: { mode: "tokens", tokens: 123 } } } },
    defaults: { profileId: "gemma" },
  };
}
function frame(delta: Record<string, unknown>, finish_reason: string | null = null): string {
  return `data: ${JSON.stringify({ id: "test-response", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
}
const complete = frame({ reasoning_content: "private reasoning" }) + frame({ content: '{"ok":true}' }) +
  frame({}, "stop") + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}
beforeEach(() => {
  configureDebugLogger({ enabled: false });
  configureModelIoTrace({ enabled: false });
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetDebugLoggerConfig();
  resetModelIoTraceConfig();
});

describe("llama.cpp gateway integration with fake HTTP provider", () => {
  test.each(["chat", "raw"] as const)("%s uses registered adapter, separated output and exact completion/usage", async (endpoint) => {
    let received: { url?: string; payload?: Record<string, unknown>; authorization?: string } = {};
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const provider = createServer((req, res) => {
      let body = "";
      req.on("data", (value) => { body += value; });
      req.on("end", () => {
        received = { url: req.url, payload: JSON.parse(body), authorization: req.headers.authorization };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.on("close", markClosed);
        res.write(complete); // Deliberately held open after the native terminal marker.
      });
    });
    try {
      const baseUrl = await listen(provider);
      const output = response();
      const handler = endpoint === "chat" ? createChatHandler({ modelPolicy: policy(baseUrl) }) : createRawHandler({ modelPolicy: policy(baseUrl) });
      await handler({ modelStep: "supervisor.response", text: "hello", format: { type: "json_schema", name: "result",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } }, output);
      await closed;
      expect(received.url).toBe("/v1/chat/completions");
      expect(received.authorization).toBeUndefined();
      expect(received.payload).toMatchObject({ model: "fixture-gemma", reasoning_budget_tokens: 123,
        chat_template_kwargs: { enable_thinking: true }, reasoning_format: "deepseek",
        response_format: { type: "json_schema", json_schema: { name: "result" } } });
      expect(received.payload).not.toHaveProperty("max_tokens");
      if (endpoint === "chat") {
        const events = output.body.trim().split("\n").map((line) => JSON.parse(line));
        expect(events).toEqual([
          { type: "thinking", text: "private reasoning" }, { type: "content", text: '{"ok":true}' },
          { type: "done", done: true, doneReason: "stop", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } },
        ]);
      } else {
        expect(JSON.parse(output.body)).toEqual({ text: '{"ok":true}', thinking: "private reasoning",
          providerCompletionReason: "stop", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } });
      }
    } finally { await close(provider); }
  });

  test.each(["chat", "raw"] as const)("%s cancellation closes the active upstream stream without a done", async (endpoint) => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const provider = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.on("close", markClosed);
        res.write(frame({ reasoning_content: "active reasoning" }));
        markStarted();
      });
    });
    const controller = new AbortController();
    try {
      const baseUrl = await listen(provider);
      const output = response();
      const handler = endpoint === "chat" ? createChatHandler({ modelPolicy: policy(baseUrl) }) : createRawHandler({ modelPolicy: policy(baseUrl) });
      const active = handler({ text: "hello" }, output, { abortSignal: controller.signal });
      await started;
      controller.abort();
      await active;
      await closed;
      expect(output.body).not.toContain('"type":"done"');
    } finally { controller.abort(); await close(provider); }
  });

  test("tracing completes for a held-open terminal stream and redacts credentials", async () => {
    const artifacts = join(process.cwd(), ".codex", "artifacts", "llamacpp-transport-tests");
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(join(artifacts, "trace-"));
    const traceFile = join(directory, "model-io.jsonl");
    configureModelIoTrace({ enabled: true, traceFile });
    vi.stubEnv("LLAMACPP_TRACE_TEST_KEY", "fake-private-credential");
    const fakeFetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(complete)); },
    })));
    const modelPolicy = policy("http://fake-provider.invalid");
    modelPolicy.providers!.local!.apiKeyEnv = "LLAMACPP_TRACE_TEST_KEY";
    try {
      await createChatHandler({ modelPolicy, fetchImpl: fakeFetch })({ text: "trace me" }, response());
      const lines = await readFile(traceFile, "utf8");
      expect(lines).not.toContain("fake-private-credential");
      expect(lines).toContain('"event":"provider.response"');
      expect(lines).toContain('"thinking":"private reasoning"');
      expect(lines).toContain('"reasoning_budget_tokens":123');
      expect(lines).toContain('"inputTokens":12');
    } finally { configureModelIoTrace({ enabled: false }); await rm(directory, { recursive: true, force: true }); }
  });

  test("provider failures and incomplete streams do not become successful completion", async () => {
    const modelPolicy = policy("http://fake-provider.invalid");
    const nativeError = response();
    await createChatHandler({ modelPolicy, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("not ready", { status: 503 })) })
      ({ text: "hello" }, nativeError);
    expect(nativeError.statusCode).toBe(503);
    const incomplete = response();
    await createChatHandler({ modelPolicy, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(frame({ content: "partial" }))) })
      ({ text: "hello" }, incomplete);
    expect(incomplete.body).toContain('"type":"error"');
    expect(incomplete.body).not.toContain('"type":"done"');
  });

  test("context admission rejects the final envelope before any provider fetch", async () => {
    const modelPolicy = policy("http://fake-provider.invalid");
    modelPolicy.profiles!.gemma!.contextWindowTokens = 20;
    const fetchImpl = vi.fn<typeof fetch>();
    const output = response();
    await createChatHandler({ modelPolicy, fetchImpl })({ text: "long input ".repeat(100) }, output);
    expect(output.statusCode).toBe(400);
    expect(output.body).toContain("model_context_window_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("declares embeddings and counting without image capability and rejects images and raw tools without fetching", async () => {
    const adapter = createBuiltInModelProviderAdapterRegistry({ ollamaUrl: "http://unused" }).resolve("llamacpp");
    expect(adapter.supportsImageInput).toBe(false);
    expect(adapter.embed).toBeTypeOf("function");
    expect(adapter.listEmbeddingModels).toBeUndefined();
    expect(adapter.countInputTokens).toBeTypeOf("function");
    const fetchImpl = vi.fn<typeof fetch>();
    const modelPolicy = policy("http://fake-provider.invalid");
    const image = response();
    await createChatHandler({ modelPolicy, fetchImpl })({ messages: [{ role: "user", content: "", attachments: [
      { id: "image", kind: "image", mimeType: "image/png", storageRef: "test", data: "ZmFrZQ==" },
    ] }] }, image);
    expect(image.statusCode).toBe(400);
    const raw = response();
    const request: ModelGatewayRequest = { messages: [
      { role: "assistant", content: "", toolCalls: [{ callId: "call-1", name: "write", arguments: "{}" }] },
      { role: "tool", content: "ok", toolCallId: "call-1", toolName: "write" },
    ] };
    await createRawHandler({ modelPolicy, fetchImpl })(request, raw);
    expect(raw.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
