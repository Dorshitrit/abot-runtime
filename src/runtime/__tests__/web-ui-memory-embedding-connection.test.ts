import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBuiltInModelProviderAdapterRegistry } from "../../model-gateway/providers/registry.js";
import { MemoryEmbeddingConnectionService } from "../../web-ui/local-runtime/memory-embedding-connection-service.js";
import { SetupEmbeddingRoutes } from "../../web-ui/local-runtime/setup-embedding-routes.js";
import { isolatedProviderCredentialName } from "../../web-ui/local-runtime/provider-credential-identity.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let server: Server;
let baseUrl: string;
const httpFetch = globalThis.fetch;
const fetchMock = vi.fn<typeof fetch>();
const key = "synthetic-memory-embedding-key";
const connection = {
  provider: "llamacpp",
  newProviderId: "llamacpp-embedding",
  model: "qwen3-embedding-fixture",
  baseUrl: "http://127.0.0.1:8081",
};

beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/memory-embedding-connection-20261019/backend",
  );
  const config = await fixture.readConfig();
  config.models.providers.llamacpp = {
    type: "llamacpp",
    baseUrl: "http://127.0.0.1:8080",
    apiKeyEnv: "LLAMA_MEMORY_CHAT_FIXTURE_KEY",
  };
  config.models.embeddingProfiles = {
    previous: { provider: "ollama", model: "previous-embedding" },
  };
  config.longTermMemory = {
    enabled: true,
    embeddingProfileId: "previous",
    emitClientEvents: true,
    maxRecallCallsPerRequest: 2,
  };
  config.plugins = {
    ...config.plugins,
    allow: ["*"],
    deny: ["web"],
    disabledPluginIds: ["mail"],
  };
  await fixture.writeConfig(config);
  const profileId = Object.keys(config.models.profiles)[0];
  await fixture.writeModelProfile(profileId, {
    ...(await fixture.readModelProfile(profileId)),
    provider: "llamacpp",
  });
  vi.stubEnv("LLAMA_MEMORY_CHAT_FIXTURE_KEY", "synthetic-chat-key");
  fetchMock
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ data: [{ index: 0, embedding: [0.2, 0.4, 0.6] }] }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const routes = new SetupEmbeddingRoutes(
    new MemoryEmbeddingConnectionService({
      rootDir: fixture.rootDir,
      getConfigPath: () => fixture.configPath,
      providerAdapters: createBuiltInModelProviderAdapterRegistry({
        ollamaUrl: "http://127.0.0.1:11434",
      }),
    }),
    "runtime/memory/connection",
  );
  server = createServer((request, response) => {
    const route = new URL(request.url!, "http://localhost").pathname.slice(
      "/web-api/".length,
    );
    void routes
      .handle({ method: request.method!, route, request, response })
      .then((handled) => {
        if (!handled) {
          response.statusCode = 404;
          response.end();
        }
      })
      .catch(() => {
        response.statusCode = 500;
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.cleanup();
});

async function post(
  input: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await httpFetch(
    `${baseUrl}/web-api/runtime/memory/connection?environment=dev`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    },
  );
  return { response, payload: (await response.json()) as Record<string, any> };
}

describe("Memory settings embedding connection endpoint", () => {
  test("probes a separate authenticated server and preserves plugin, events, profile and chat configuration", async () => {
    const before = await fixture.readConfig();
    const chatId = Object.keys(before.models.profiles)[0];
    const chatProfile = await fixture.readModelProfile(chatId);
    const { response, payload } = await post({
      ...connection,
      useApiKey: true,
      apiKey: key,
    });
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      restartRequired: true,
      configPath: fixture.configPath,
      status: {
        enabled: true,
        profileId: "previous",
        emitClientEvents: true,
        providerId: connection.newProviderId,
      },
      probe: { dimensions: 3 },
    });
    expect(typeof payload.backupPath).toBe("string");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8081/v1/embeddings");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${key}`,
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: connection.model,
      encoding_format: "float",
    });
    const saved = await fixture.readConfig();
    expect(saved.models.providers.llamacpp).toEqual(
      before.models.providers.llamacpp,
    );
    expect(saved.models.profiles).toEqual(before.models.profiles);
    expect(saved.models.defaultProfile).toEqual(before.models.defaultProfile);
    expect(await fixture.readModelProfile(chatId)).toEqual(chatProfile);
    expect(saved.plugins).toEqual(before.plugins);
    expect(saved.longTermMemory).toEqual(before.longTermMemory);
    expect(saved.models.embeddingProfiles.previous).toMatchObject({
      provider: connection.newProviderId,
      model: connection.model,
    });
    expect(saved.models.providers[connection.newProviderId].apiKeyEnv).toBe(
      isolatedProviderCredentialName(connection.newProviderId),
    );
    expect(JSON.stringify(saved)).not.toContain(key);
    expect(JSON.stringify(payload)).not.toContain(key);
  });

  test("accepts explicit event and profile selection without inheriting a chat or orphan key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "unrelated-cloud-key");
    vi.stubEnv(
      isolatedProviderCredentialName(connection.newProviderId),
      "unrelated-orphan-key",
    );
    const before = await fixture.readConfig();
    const { response, payload } = await post({
      ...connection,
      useApiKey: false,
      emitClientEvents: false,
      profileId: "settings-embedding",
    });
    expect(response.status).toBe(200);
    expect(payload.status).toMatchObject({
      emitClientEvents: false,
      profileId: "settings-embedding",
    });
    expect(
      new Headers(fetchMock.mock.calls[0]![1]?.headers).has("authorization"),
    ).toBe(false);
    const saved = await fixture.readConfig();
    expect(saved.models.providers[connection.newProviderId]).not.toHaveProperty(
      "apiKeyEnv",
    );
    expect(saved.models.embeddingProfiles.previous).toEqual(
      before.models.embeddingProfiles.previous,
    );
    expect(saved.plugins).toEqual(before.plugins);
  });

  test("an empty optional profile selection preserves the currently selected profile", async () => {
    const { response, payload } = await post({
      ...connection,
      profileId: "  ",
    });
    expect(response.status).toBe(200);
    expect(payload.status.profileId).toBe("previous");
  });

  test("returns only the saved connection identity after failed probe and retries with its isolated credential", async () => {
    const before = await fixture.readConfig();
    fetchMock.mockResolvedValueOnce(
      new Response("private failure " + key, { status: 500 }),
    );
    const failed = await post({
      ...connection,
      apiKey: key,
      useApiKey: true,
      emitClientEvents: false,
    });
    expect(failed.response.status).toBe(400);
    expect(failed.payload).toMatchObject({
      ok: false,
      providerSaved: true,
      savedProvider: { id: connection.newProviderId, type: "llamacpp" },
    });
    expect(JSON.stringify(failed.payload)).not.toContain(key);
    const afterFailure = await fixture.readConfig();
    expect(afterFailure.longTermMemory).toEqual(before.longTermMemory);
    expect(afterFailure.models.embeddingProfiles).toEqual(
      before.models.embeddingProfiles,
    );
    expect(afterFailure.plugins).toEqual(before.plugins);
    const retried = await post({
      providerId: connection.newProviderId,
      model: connection.model,
      emitClientEvents: false,
    });
    expect(retried.response.status).toBe(200);
    expect(retried.payload.status).toMatchObject({
      profileId: "previous",
      emitClientEvents: false,
    });
    expect((await fixture.readConfig()).models.providers).toEqual(
      afterFailure.models.providers,
    );
    expect(
      new Headers(fetchMock.mock.calls[1]![1]?.headers).get("authorization"),
    ).toBe(`Bearer ${key}`);
  });

  test.each([
    { emitClientEvents: "true" },
    { profileId: 42 },
    { profileId: "bad/profile" },
    { unknownField: true },
    { environment: "other" },
  ])(
    "rejects malformed input before saving a connection: %j",
    async (override) => {
      const before = await fixture.readConfig();
      const { response, payload } = await post({ ...connection, ...override });
      expect(response.status).toBe(400);
      expect(payload.providerSaved).toBe(false);
      expect(await fixture.readConfig()).toEqual(before);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("rejects cross-origin writes and unsupported methods before any persistence or probe", async () => {
    const before = await fixture.readConfig();
    expect(
      (await post(connection, { origin: "http://untrusted.example" })).response
        .status,
    ).toBe(403);
    const response = await httpFetch(
      `${baseUrl}/web-api/runtime/memory/connection`,
    );
    expect(response.status).toBe(405);
    expect(await fixture.readConfig()).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
