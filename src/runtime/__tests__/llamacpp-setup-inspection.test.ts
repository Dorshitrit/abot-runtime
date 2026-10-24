import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { inspectModelSetupConnection } from "../../web-ui/local-runtime/model-connection-inspection.js";
import { availableEmbeddingProviders } from "../adapters/long-term-memory/onboarding-provider-availability.js";
import { createBuiltInModelProviderAdapterRegistry } from "../../model-gateway/providers/registry.js";

const inspect = vi.hoisted(() => vi.fn(async (_input: { baseUrl: string; apiKey?: string; signal?: AbortSignal }) => ({ models: ["local-gemma"] })));
vi.mock("../../model-gateway/providers/llamacpp/connection.js", () => ({ inspectLlamaCppConnection: inspect }));
let rootDir: string;
let configPath: string;
beforeEach(async () => {
  const artifacts = resolve(".codex/artifacts/llamacpp-setup-20261019");
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "inspect-"));
  configPath = join(rootDir, "runtime.config.json");
  await writeFile(configPath, JSON.stringify({ models: { providers: {
    secured: { type: "llamacpp", baseUrl: "http://saved-server:8080", apiKeyEnv: "LLAMA_INSPECTION_FIXTURE" },
    llamacpp: { type: "llamacpp", baseUrl: "http://saved-server:8080", apiKeyEnv: "LLAMA_INSPECTION_FIXTURE" },
    local: { type: "ollama", baseUrl: "http://ollama:11434" },
  } } }));
  vi.stubEnv("LLAMA_INSPECTION_FIXTURE", "synthetic-inspection-key");
  inspect.mockClear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});
describe("explicit metadata-only llama connection inspection", () => {
  test("resolves saved provider credentials privately and returns model IDs only", async () => {
    const result = await inspectModelSetupConnection({ rootDir, configPath }, { providerId: "secured" }, new AbortController().signal);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "http://saved-server:8080", apiKey: "synthetic-inspection-key" }));
    expect(result).toEqual({ models: ["local-gemma"] });
    expect(JSON.stringify(result)).not.toContain("synthetic-inspection-key");
  });
  test("never forwards a saved key to an edited server address", async () => {
    await inspectModelSetupConnection({ rootDir, configPath }, { provider: "llamacpp", baseUrl: "http://different-server:8080" }, new AbortController().signal);
    expect(inspect.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
  });
  test("rejects unsupported selections and unsafe addresses before network access", async () => {
    await expect(inspectModelSetupConnection({ rootDir, configPath }, { providerId: "local" }, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_connection_inspection" });
    await expect(inspectModelSetupConnection({ rootDir, configPath }, { provider: "llamacpp", baseUrl: "http://user:pass@server:8080" }, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_connection_address" });
    expect(inspect).not.toHaveBeenCalled();
  });
  test("includes llama.cpp embedding support while filtering chat-only adapters", () => {
    const registry = createBuiltInModelProviderAdapterRegistry({ ollamaUrl: "http://ollama:11434", additionalAdapters: [{ type: "chat-only", supportsImageInput: false, invoke: async () => ({ kind: "raw", body: {} }) }] });
    expect(availableEmbeddingProviders([
      { id: "local", type: "ollama" }, { id: "cloud", type: "openai" }, { id: "llama", type: "llamacpp" }, { id: "chat", type: "chat-only" },
    ], registry)).toEqual([{ id: "local", type: "ollama" }, { id: "cloud", type: "openai" }, { id: "llama", type: "llamacpp" }]);
  });
});
