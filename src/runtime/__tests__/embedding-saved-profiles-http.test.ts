import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBuiltInModelProviderAdapterRegistry } from "../../model-gateway/providers/registry.js";
import { createLocalLongTermMemoryOnboardingService } from "../adapters/long-term-memory/onboarding-service.js";
import { LongTermMemoryOnboardingRoutes } from "../../web-ui/local-runtime/memory-onboarding-routes.js";
import { readBody, readJsonBody } from "../../web-ui/local-runtime/http.js";
import { createModelSetupFixture, type ModelSetupFixture } from "./support/model-setup-fixture.js";
// @ts-expect-error Browser JavaScript module.
import { createLongTermMemoryRequests } from "../../web-ui/app/services/runtime-web-client/memory.js";

let fixture: ModelSetupFixture;
let server: Server;
let baseUrl: string;
const providerFetch = vi.fn<typeof fetch>();

beforeEach(async () => {
  fixture = await createModelSetupFixture(".codex/artifacts/embedding-profiles-20261023/http");
  const config = await fixture.readConfig();
  config.models.providers.cpp = { type: "llamacpp", baseUrl: "http://127.0.0.1:8081" };
  config.models.embeddingProfiles = {
    existing: { provider: "ollama", model: "existing", label: "Existing", options: { dimensions: 512 } },
  };
  config.longTermMemory = { enabled: true, embeddingProfileId: "existing" };
  await fixture.writeConfig(config);
  providerFetch.mockReset().mockResolvedValue(Response.json({ data: [{ index: 0, embedding: [0.25, 0.75] }] }));
  const service = () => createLocalLongTermMemoryOnboardingService({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    providerAdapters: createBuiltInModelProviderAdapterRegistry({ ollamaUrl: "http://127.0.0.1:11434" }),
    fetchImpl: providerFetch,
  });
  const routes = new LongTermMemoryOnboardingRoutes(service);
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, baseUrl);
      const handled = await routes.handle({
        method: request.method!,
        route: url.pathname.slice("/web-api/".length),
        url,
        body: request.method === "GET" ? null : readJsonBody(await readBody(request)),
        request, response,
      });
      if (!handled) { response.statusCode = 404; response.end(); }
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.cleanup();
});

async function post(path: string, input: unknown, headers = {}) {
  const response = await fetch(`${baseUrl}/web-api/runtime/memory/${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input),
  });
  return { response, payload: await response.json() as Record<string, any> };
}

describe("saved embedding profile HTTP contract", () => {
  test("browser client saves through canonical linked config and reads it after service recreation", async () => {
    const before = await fixture.readConfig();
    const client = createLongTermMemoryRequests({
      getEnvironmentId: () => "dev", environmentQuery: encodeURIComponent,
      requestApi: async (path: string, init: RequestInit = {}) => {
        const response = await fetch(`${baseUrl}/web-api${path}`, {
          ...init, headers: { "content-type": "application/json" },
        });
        expect(response.status).toBe(200);
        return response.json();
      },
    });
    const result = await client.saveMemoryEmbeddingProfile({
      providerId: "cpp", model: "qwen3-embedding:0.6b", label: "Qwen llama.cpp",
    });
    expect(result).not.toHaveProperty("restartRequired");
    expect(providerFetch).not.toHaveBeenCalled();
    const after = await fixture.readConfig();
    expect(after.longTermMemory).toEqual(before.longTermMemory);
    expect(after.models.providers).toEqual(before.models.providers);
    expect(after.models.profiles).toEqual(before.models.profiles);
    expect(after.models.embeddingProfiles[result.profileId]).toEqual({
      provider: "cpp", model: "qwen3-embedding:0.6b", label: "Qwen llama.cpp",
    });
    const status = await client.loadLongTermMemoryStatus();
    expect(status.status.profileId).toBe("existing");
    expect(status.status.embeddingProfiles).toContainEqual({
      id: result.profileId, providerId: "cpp", model: "qwen3-embedding:0.6b", label: "Qwen llama.cpp",
    });
    const activated = await post("enable", {
      providerId: "cpp", model: "qwen3-embedding:0.6b", profileId: result.profileId,
    });
    expect(activated.response.status).toBe(200);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(activated.payload.status.profileId).toBe(result.profileId);
    expect((await fixture.readConfig()).models.embeddingProfiles[result.profileId].label).toBe("Qwen llama.cpp");
  });

  test("browser client removes only its exact saved profile and GET reflects the persisted removal", async () => {
    const before = await fixture.readConfig();
    const saved = await post("profiles", { providerId: "cpp", model: "qwen", label: "Qwen" });
    const client = createLongTermMemoryRequests({
      getEnvironmentId: () => "dev", environmentQuery: encodeURIComponent,
      requestApi: async (path: string, init: RequestInit = {}) => {
        const response = await fetch(`${baseUrl}/web-api${path}`, {
          ...init, headers: { "content-type": "application/json" },
        });
        expect(response.status).toBe(200);
        return response.json();
      },
    });
    const result = await client.removeMemoryEmbeddingProfile({ profileId: saved.payload.profileId });
    expect(result).toMatchObject({ ok: true, removed: true, profileId: saved.payload.profileId });
    expect(result).not.toHaveProperty("restartRequired");
    expect(await fixture.readConfig()).toEqual(before);
    expect((await client.loadLongTermMemoryStatus()).status.embeddingProfiles).not.toContainEqual(
      expect.objectContaining({ id: saved.payload.profileId }),
    );
    expect(providerFetch).not.toHaveBeenCalled();
  });

  test("DELETE protects configured profiles and rejects foreign origins or missing IDs without mutation", async () => {
    const before = await fixture.readConfig();
    for (const [profileId, origin, expectedStatus] of [
      ["existing", undefined, 409], ["missing", undefined, 404],
      ["existing", "https://untrusted.test", 403],
    ] as const) {
      const response = await fetch(`${baseUrl}/web-api/runtime/memory/profiles`, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ profileId, environment: "dev" }),
      });
      expect(response.status).toBe(expectedStatus);
    }
    expect(await fixture.readConfig()).toEqual(before);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  test("rejects cross-origin writes and invalid provider without mutating stored config", async () => {
    const before = await fixture.readConfig();
    const input = { providerId: "cpp", model: "qwen", label: "Qwen" };
    expect((await post("profiles", input, { origin: "https://untrusted.test" })).response.status).toBe(403);
    expect((await post("profiles", { ...input, providerId: "missing" })).response.status).toBe(400);
    expect(await fixture.readConfig()).toEqual(before);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
