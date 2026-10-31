import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { createModelGatewayClient } from "../../../client.js";
import { createModelGatewayServer } from "../../../server.js";
import { createModelProviderAdapterRegistry } from "../../../providers/contracts.js";
import { createOpenAIProviderAdapter } from "../../../providers/openai/adapter.js";
import { createChatGptProviderAdapter } from "../../../providers/openai-chatgpt/adapter.js";
import { controlsFormat } from "../../../providers/openai/__tests__/native-function-fixture.js";

export async function createContextOverflowFlow(
  provider: "openai" | "openai-chatgpt",
  upstream: () => Response,
  prompt = "Check capacity.",
) {
  const artifacts = join(process.cwd(), ".codex/artifacts/hf221-1031/gateway-tests");
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "overflow-"));
  const modelPolicy = {
    providers: { fixture: provider === "openai"
      ? { type: provider, baseUrl: "https://provider.test/v1", apiKeyEnv: "OVERFLOW_FIXTURE_KEY" }
      : { type: provider, settings: { accountRef: "12345678-1234-4123-8123-123456789abc" } } },
    profiles: { fixture: { provider: "fixture", model: "fixture", contextWindowTokens: 32_768 } },
    defaults: { profileId: "fixture" },
  };
  await writeFile(join(rootDir, "runtime.config.json"), JSON.stringify({
    logging: { enabled: false }, models: modelPolicy, requestRunner: { configRef: "./runner.json" },
  }));
  await writeFile(join(rootDir, "runner.json"), JSON.stringify({
    schemaVersion: 2, models: { defaults: { profileId: "fixture", steps: {} } },
    context: { outputReserveTokens: 1024, safetyReserveTokens: 256, attachmentReserveTokens: 256 },
    stepDefaults: { timeoutMs: 5000 }, steps: {},
  }));
  const fetchImpl = vi.fn<typeof fetch>(async () => upstream());
  const gateway = createModelGatewayServer({
    rootDir, modelPolicy, fetchImpl,
    providerAdapters: createModelProviderAdapterRegistry([
      createOpenAIProviderAdapter(),
      createChatGptProviderAdapter({ getAccessToken: async () => "test-only-plan-token" }),
    ]),
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("fixture_port_missing");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = createModelGatewayClient({ baseUrl });
  const body = { messages: [{ role: "user" as const, content: prompt }], prompt,
    modelStep: "capability.controls" as const, format: controlsFormat };
  return {
    fetchImpl,
    post(endpoint: "chat" | "raw") {
      return fetch(`${baseUrl}/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    },
    invoke(endpoint: "chat" | "raw") {
      const common = { ...body, agentMode: "reasoning" as const, abortSignal: AbortSignal.timeout(5000) };
      return endpoint === "chat" ? client.invoke(common) : client.invokeRaw(common);
    },
    async dispose() {
      await new Promise<void>((resolve) => {
        gateway.close(() => resolve());
        gateway.closeAllConnections();
      });
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}
