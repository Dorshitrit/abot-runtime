import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createModelGatewayServer } from "../server.js";
import { createModelGatewayClient } from "../client.js";
import { configureModelIoTrace, resetModelIoTraceConfig } from "../model-io-trace.js";
import { resetDebugLoggerConfig } from "../../runtime/observability/debug-logger.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetModelIoTraceConfig();
  resetDebugLoggerConfig();
});

test.each([
  ["chat", false], ["chat", true], ["raw", false], ["raw", true],
] as const)("%s HTTP client and gateway complete before provider EOF, tracing=%s", async (endpoint, traceEnabled) => {
  const rootDir = await mkdtemp(join(tmpdir(), "abot-terminal-test-"));
  vi.stubEnv("TERMINAL_HTTP_TEST_KEY", "fake-local-provider");
  let markClosed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => { markClosed = resolve; });
  const responseBody = [
    { type: "response.output_text.delta", delta: "complete answer" },
    { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
  ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const provider = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.on("close", markClosed);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(responseBody);
      // Never call res.end(): only the gateway can close this response.
    });
  });
  const providerUrl = await listen(provider);
  const modelPolicy = {
    providers: { test: { type: "openai", baseUrl: providerUrl, apiKeyEnv: "TERMINAL_HTTP_TEST_KEY" } },
    profiles: { test: { provider: "test", model: "fixture", contextWindowTokens: 32768 } },
    defaults: { profileId: "test" },
  };
  await writeFile(join(rootDir, "runtime.config.json"), JSON.stringify({
    logging: { enabled: false }, models: modelPolicy, requestRunner: { configRef: "./runner.json" },
  }));
  await writeFile(join(rootDir, "runner.json"), JSON.stringify({
    schemaVersion: 2, models: { defaults: { profileId: "test", steps: {} } },
    context: { outputReserveTokens: 1024, safetyReserveTokens: 256, attachmentReserveTokens: 256 },
    stepDefaults: { timeoutMs: 5000 }, steps: {},
  }));
  const gateway = createModelGatewayServer({ rootDir, modelPolicy });
  const traceFile = join(rootDir, "trace.jsonl");
  configureModelIoTrace({ traceFile, enabled: traceEnabled });
  const abort = new AbortController();
  try {
    const client = createModelGatewayClient({ baseUrl: await listen(gateway) });
    const common = { agentMode: "fast" as const, modelStep: "supervisor.response" as const, abortSignal: abort.signal };
    const result = endpoint === "chat"
      ? await client.invoke({ ...common, text: "local fixture" })
      : await client.invokeRaw({ ...common, prompt: "local fixture" });
    expect(result.text).toBe("complete answer");
    expect(result.meta.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    await upstreamClosed;
    if (traceEnabled) {
      const entries = (await readFile(traceFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(entries.map((entry) => entry.event)).toEqual(["provider.request", "provider.response"]);
      expect(entries[1].response).toMatchObject({
        body: responseBody, decoded: { text: "complete answer", thinking: "" },
        stream: { sse: { eventTypes: { "response.completed": 1 } } },
      });
    }
  } finally {
    abort.abort();
    await close(gateway);
    await close(provider);
    await rm(rootDir, { recursive: true, force: true });
  }
});
