import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createModelGatewayClient } from "../../../model-gateway/client.js";
import { createModelGatewayServer } from "../../../model-gateway/server.js";
import type { ModelGatewayClient } from "../../ports.js";

type RetryProviderOutput = Readonly<{ text: string; ending?: "eof" | "socket" }>;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_port_missing");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function responseFrames(output: RetryProviderOutput, request: Record<string, unknown>, index: number): string {
  const responseId = `resp_retry_${index}`;
  const choice = request.tool_choice as { type?: string; name?: string } | undefined;
  const name = choice?.type === "function" ? choice.name : undefined;
  const call = name ? {
    type: "function_call", id: `fc_retry_${index}`, call_id: `call_retry_${index}`,
    name, arguments: output.text, status: "completed",
  } : undefined;
  const events: unknown[] = [{ type: "response.created", response: {
    id: responseId, status: "in_progress", output: [],
  } }];
  if (call) {
    events.push({ type: "response.output_item.added", output_index: 0,
      item: { ...call, status: "in_progress", arguments: "" } });
    events.push({ type: "response.function_call_arguments.delta", output_index: 0,
      item_id: call.id, delta: output.text });
  }
  if (!call) events.push({ type: "response.output_text.delta", delta: output.text });
  if (output.ending === undefined) events.push({ type: "response.completed", response: {
    id: responseId, status: "completed", ...(call ? { output: [call] } : {}),
  } });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** Real gateway/HTTP transport, with only the external provider scripted. */
export async function createProviderStreamRetryFixture(outputs: readonly RetryProviderOutput[]) {
  const rootDir = await mkdtemp(join(tmpdir(), "abot-provider-stream-retry-"));
  vi.stubEnv("PROVIDER_STREAM_RETRY_FIXTURE_KEY", "fixture-only");
  const providerRequests: Record<string, unknown>[] = [];
  const pendingDisconnects = new Set<ReturnType<typeof setTimeout>>();
  const provider = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body) as Record<string, unknown>;
      providerRequests.push(request);
      const output = outputs[providerRequests.length - 1];
      if (!output) {
        res.writeHead(500);
        res.end("unexpected_provider_invocation");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frames = responseFrames(output, request, providerRequests.length);
      if (output.ending === "socket") {
        res.flushHeaders();
        res.write(frames);
        const timer = setTimeout(() => {
          pendingDisconnects.delete(timer);
          res.destroy();
        }, 25);
        pendingDisconnects.add(timer);
        return;
      }
      res.end(frames);
    });
  });
  let providerUrl: string;
  try {
    providerUrl = await listen(provider);
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
  const modelPolicy = {
    providers: { test: { type: "openai", baseUrl: providerUrl, apiKeyEnv: "PROVIDER_STREAM_RETRY_FIXTURE_KEY" } },
    profiles: { test: { provider: "test", model: "fixture", contextWindowTokens: 128_000 } },
    defaults: { profileId: "test", steps: {} },
  };
  await writeFile(join(rootDir, "runtime.config.json"), JSON.stringify({
    logging: { enabled: false }, models: modelPolicy, requestRunner: { configRef: "./runner.json" },
  }));
  await writeFile(join(rootDir, "runner.json"), JSON.stringify({
    schemaVersion: 2, models: { defaults: { profileId: "test", steps: {} } },
    context: { outputReserveTokens: 1_000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
    stepDefaults: { timeoutMs: 5_000 }, steps: {},
  }));
  const gateway = createModelGatewayServer({ rootDir, modelPolicy });
  const client = createModelGatewayClient({ baseUrl: await listen(gateway) });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(client.invoke);
  return {
    rootDir, modelPolicy, invoke, providerRequests,
    modelGatewayClient: { invoke, invokeRaw: client.invokeRaw },
    dispose: async () => {
      for (const timer of pendingDisconnects) clearTimeout(timer);
      pendingDisconnects.clear();
      await close(gateway);
      await close(provider);
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}
