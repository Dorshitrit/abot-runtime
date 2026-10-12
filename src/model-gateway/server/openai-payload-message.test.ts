import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createModelGatewayServer } from "../server.js";
import { createModelGatewayClient } from "../client.js";
import { resetDebugLoggerConfig } from "../../runtime/observability/debug-logger.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}
afterEach(() => { vi.unstubAllEnvs(); resetDebugLoggerConfig(); });

test.each(["chat", "raw"] as const)("plain tool payload survives provider phases through the %s HTTP client", async (endpoint) => {
  const rootDir = await mkdtemp(join(tmpdir(), "abot-payload-message-test-"));
  vi.stubEnv("PAYLOAD_HTTP_TEST_KEY", "fake-local-provider");
  const products = [{ id: "lamp", name: "מנורה" }];
  const final = JSON.stringify(products);
  const responseBody = [
    { type: "response.output_item.added", output_index: 0,
      item: { type: "message", id: "draft", phase: "commentary" } },
    { type: "response.output_text.delta", output_index: 0, item_id: "draft", delta: `${final}\n*** End Patch` },
    { type: "response.output_item.added", output_index: 1,
      item: { type: "message", id: "final", phase: "final_answer" } },
    { type: "response.output_text.delta", output_index: 1, item_id: "final", delta: final },
    { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
  ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const provider = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(responseBody);
    });
  });
  const modelPolicy = {
    providers: { test: { type: "openai", baseUrl: await listen(provider), apiKeyEnv: "PAYLOAD_HTTP_TEST_KEY" } },
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
  const abort = new AbortController();
  try {
    const client = createModelGatewayClient({ baseUrl: await listen(gateway) });
    const common = { agentMode: "fast" as const, modelStep: "tool_payload.raw" as const, abortSignal: abort.signal };
    const result = endpoint === "chat"
      ? await client.invoke({ ...common, text: "local fixture" })
      : await client.invokeRaw({ ...common, prompt: "local fixture" });
    expect(result.text).toBe(final);
    expect(JSON.parse(result.text)).toEqual(products);
    expect(result.meta.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  } finally {
    abort.abort();
    await close(gateway);
    await close(provider);
    await rm(rootDir, { recursive: true, force: true });
  }
});
