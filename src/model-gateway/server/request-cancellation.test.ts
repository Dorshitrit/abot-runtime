import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createModelGatewayServer } from "../server.js";
import { resetDebugLoggerConfig } from "../../runtime/observability/debug-logger.js";
import { resetModelIoTraceConfig } from "../model-io-trace.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
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
  resetDebugLoggerConfig();
  resetModelIoTraceConfig();
});

test.each([
  ["ollama", "chat"],
  ["ollama", "raw"],
  ["openai", "chat"],
  ["openai", "raw"],
] as const)(
  "%s %s disconnect closes an active provider stream",
  async (type, endpoint) => {
    const rootDir = await mkdtemp(join(tmpdir(), "abot-stop-provider-"));
    vi.stubEnv("ABOT_STOP_TEST_KEY", "local-fake-provider-only");
    let receivedPath = "";
    let markClosed!: () => void;
    const providerClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    let markStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const provider = createServer((req, res) => {
      receivedPath = req.url ?? "";
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type":
            type === "openai" ? "text/event-stream" : "application/x-ndjson",
        });
        res.on("close", markClosed);
        const chunk =
          type === "openai"
            ? `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`
            : `${JSON.stringify({ message: { role: "assistant", content: "partial" }, response: "partial", done: false })}\n`;
        res.write(chunk);
        markStarted();
        // Intentionally remain open until the user cancels the downstream request.
      });
    });
    const baseUrl = await listen(provider);
    const modelPolicy = {
      providers: { test: { type, baseUrl, apiKeyEnv: "ABOT_STOP_TEST_KEY" } },
      profiles: {
        test: {
          provider: "test",
          model: "test-model",
          contextWindowTokens: 32768,
        },
      },
      defaults: { profileId: "test" },
    };
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        logging: { enabled: false },
        models: modelPolicy,
        requestRunner: { configRef: "./runner.json" },
      }),
    );
    await writeFile(
      join(rootDir, "runner.json"),
      JSON.stringify({
        schemaVersion: 2,
        models: { defaults: { profileId: "test", steps: {} } },
        context: {
          outputReserveTokens: 1024,
          safetyReserveTokens: 256,
          attachmentReserveTokens: 256,
        },
        stepDefaults: { timeoutMs: 5000 },
        steps: {},
      }),
    );
    const gateway = createModelGatewayServer({
      rootDir,
      modelPolicy,
    });
    const clientAbort = new AbortController();
    try {
      const gatewayUrl = await listen(gateway);
      const responsePromise = fetch(`${gatewayUrl}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelStep: "supervisor.response",
          ...(endpoint === "chat"
            ? { messages: [{ role: "user", content: "Wait for cancellation" }] }
            : { prompt: "Wait for cancellation" }),
        }),
        signal: clientAbort.signal,
      });
      if (endpoint === "raw") {
        const aborted = expect(responsePromise).rejects.toMatchObject({
          name: "AbortError",
        });
        await providerStarted;
        clientAbort.abort();
        await aborted;
        await providerClosed;
        return;
      }
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      clientAbort.abort();
      await providerClosed;
      expect(receivedPath).toBe(type === "openai" ? "/responses" : "/api/chat");
      await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clientAbort.abort();
      await close(gateway);
      await close(provider);
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);
