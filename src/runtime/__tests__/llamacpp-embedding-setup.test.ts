import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBuiltInModelProviderAdapterRegistry } from "../../model-gateway/providers/registry.js";
import { createLocalLongTermMemoryOnboardingService } from "../adapters/long-term-memory/onboarding-service.js";
import * as configRepositories from "../adapters/long-term-memory/onboarding-config-repository.js";
import { isolatedProviderCredentialName } from "../../web-ui/local-runtime/provider-credential-identity.js";
import { SetupEmbeddingService } from "../../web-ui/local-runtime/setup-embedding-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let service: SetupEmbeddingService;
const fetchMock = vi.fn<typeof fetch>();
const signal = () => new AbortController().signal;
const key = "synthetic-embedding-key";
const connection = {
  provider: "llamacpp",
  newProviderId: "llamacpp-embedding",
  model: "embedding-alias",
  baseUrl: "http://127.0.0.1:18082",
};
const registry = createBuiltInModelProviderAdapterRegistry({
  ollamaUrl: "http://127.0.0.1:11434",
});
const embeddingResponse = () =>
  Response.json({ data: [{ index: 0, embedding: [0.2, 0.4, 0.6] }] });

beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/llamacpp-review-embeddings-20261019/setup",
  );
  const config = await fixture.readConfig();
  config.models.providers.llamacpp = {
    type: "llamacpp",
    baseUrl: "http://127.0.0.1:18081",
    apiKeyEnv: "LLAMA_CHAT_FIXTURE_KEY",
  };
  config.models.embeddingProfiles = {
    previous: { provider: "ollama", model: "previous-model" },
  };
  config.longTermMemory = {
    enabled: true,
    embeddingProfileId: "previous",
    maxRecallCallsPerRequest: 2,
  };
  await fixture.writeConfig(config);
  const profileId = Object.keys(config.models.profiles)[0];
  await fixture.writeModelProfile(profileId, {
    ...(await fixture.readModelProfile(profileId)),
    provider: "llamacpp",
  });
  vi.stubEnv("LLAMA_CHAT_FIXTURE_KEY", "synthetic-chat-key");
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => embeddingResponse());
  vi.stubGlobal("fetch", fetchMock);
  service = new SetupEmbeddingService({
    rootDir: fixture.rootDir,
    getConfigPath: () => fixture.configPath,
    providerAdapters: registry,
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fixture.cleanup();
});

describe("llama.cpp embedding setup through the built-in adapter", () => {
  test("saves a distinct authenticated server and probes embeddings without changing chat routing or memory policy", async () => {
    const before = await fixture.readConfig();
    const profileId = Object.keys(before.models.profiles)[0];
    const chatProfile = await fixture.readModelProfile(profileId);
    const result = await service.enable(
      { ...connection, useApiKey: true, apiKey: key },
      signal(),
    );
    expect(result.status).toMatchObject({
      enabled: true,
      providerId: connection.newProviderId,
      model: connection.model,
    });
    expect(result.probe).toMatchObject({ dimensions: 3 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:18082/v1/embeddings");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${key}`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: connection.model,
      input: ["ABot long-term memory embedding capability probe."],
      encoding_format: "float",
    });
    const after = await fixture.readConfig();
    expect(after.models.providers.llamacpp).toEqual(
      before.models.providers.llamacpp,
    );
    expect(after.models.profiles).toEqual(before.models.profiles);
    expect(after.models.defaultProfile).toEqual(before.models.defaultProfile);
    expect(await fixture.readModelProfile(profileId)).toEqual(chatProfile);
    expect(after.models.embeddingProfiles.previous).toEqual(
      before.models.embeddingProfiles.previous,
    );
    expect(after.longTermMemory.maxRecallCallsPerRequest).toBe(2);
    expect(after.models.providers[connection.newProviderId].apiKeyEnv).toBe(
      isolatedProviderCredentialName(connection.newProviderId),
    );
    expect(JSON.stringify(after)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
    const status = await createLocalLongTermMemoryOnboardingService({
      rootDir: fixture.rootDir,
      configPath: fixture.configPath,
      providerAdapters: registry,
    }).status();
    expect(status.providers).toContainEqual({
      id: connection.newProviderId,
      type: "llamacpp",
    });
  });

  test("no-auth setup ignores unrelated and orphan credentials, and reuses its saved connection", async () => {
    const apiKeyEnv = isolatedProviderCredentialName(connection.newProviderId);
    vi.stubEnv("OPENAI_API_KEY", "synthetic-cloud-key");
    vi.stubEnv(apiKeyEnv, "synthetic-orphan-key");
    await service.enable({ ...connection, useApiKey: false }, signal());
    const saved = await fixture.readConfig();
    expect(saved.models.providers[connection.newProviderId]).not.toHaveProperty(
      "apiKeyEnv",
    );
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).has("authorization"),
    ).toBe(false);
    await service.enable(
      { providerId: connection.newProviderId, model: "second-embedding" },
      signal(),
    );
    expect((await fixture.readConfig()).models.providers).toEqual(
      saved.models.providers,
    );
    expect(
      new Headers(fetchMock.mock.calls[1][1]?.headers).has("authorization"),
    ).toBe(false);
    await expect(
      service.enable(
        {
          providerId: connection.newProviderId,
          model: "second-embedding",
          apiKey: key,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "invalid_embedding_credential" });
  });

  test("failed probes retain a safe provider receipt and retry reuses its isolated saved key", async () => {
    const before = await fixture.readConfig();
    fetchMock.mockResolvedValueOnce(
      new Response("private failure " + key, { status: 500 }),
    );
    const failure = await service
      .enable({ ...connection, useApiKey: true, apiKey: key }, signal())
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "embedding_setup_failed",
      providerSaved: true,
      savedProvider: { id: connection.newProviderId, type: "llamacpp" },
    });
    expect(String(failure)).not.toContain(key);
    expect((await fixture.readConfig()).longTermMemory).toEqual(
      before.longTermMemory,
    );
    const savedProviders = (await fixture.readConfig()).models.providers;
    await service.enable(
      { providerId: connection.newProviderId, model: connection.model },
      signal(),
    );
    expect((await fixture.readConfig()).models.providers).toEqual(
      savedProviders,
    );
    expect(
      new Headers(fetchMock.mock.calls[1][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${key}`);
  });

  test("exact new-connection replay is idempotent but endpoint or binding changes conflict", async () => {
    await service.enable(
      { ...connection, useApiKey: true, apiKey: key },
      signal(),
    );
    await service.enable({ ...connection, useApiKey: true }, signal());
    const before = await fixture.readConfig();
    const env = await fixture.readEnv();
    for (const update of [
      { baseUrl: "http://127.0.0.1:18083", useApiKey: true },
      { useApiKey: false },
    ])
      await expect(
        service.enable({ ...connection, ...update }, signal()),
      ).rejects.toMatchObject({ code: "embedding_provider_conflict" });
    expect(await fixture.readConfig()).toEqual(before);
    expect(await fixture.readEnv()).toBe(env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("credential and provider persistence roll back together before a failed config commit", async () => {
    const before = await fixture.readConfig();
    const env = await fixture.readEnv();
    const makeRepository =
      configRepositories.createFileLongTermMemoryOnboardingConfigRepository;
    vi.spyOn(
      configRepositories,
      "createFileLongTermMemoryOnboardingConfigRepository",
    ).mockImplementationOnce((options) => ({
      ...makeRepository(options),
      write: async () => {
        throw new Error("synthetic config write failure");
      },
    }));
    await expect(
      service.enable({ ...connection, useApiKey: true, apiKey: key }, signal()),
    ).rejects.toMatchObject({ providerSaved: false });
    expect(await fixture.readConfig()).toEqual(before);
    expect(await fixture.readEnv()).toBe(env);
    expect(
      process.env[isolatedProviderCredentialName(connection.newProviderId)],
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      service.enable({ ...connection, useApiKey: true }, signal()),
    ).rejects.toMatchObject({ code: "embedding_credential_required" });
    await service.enable(
      { ...connection, useApiKey: true, apiKey: key },
      signal(),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("explicit authentication reuses only its isolated stored key", async () => {
    const apiKeyEnv = isolatedProviderCredentialName(connection.newProviderId);
    vi.stubEnv(apiKeyEnv, key);
    vi.stubEnv("OPENAI_API_KEY", "unrelated-cloud-key");
    await service.enable({ ...connection, useApiKey: true }, signal());
    expect(
      new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${key}`);
    expect(
      (await fixture.readConfig()).models.providers[connection.newProviderId]
        .apiKeyEnv,
    ).toBe(apiKeyEnv);
  });

  test("new authentication cannot share another provider's isolated binding", async () => {
    const config = await fixture.readConfig();
    config.models.providers.other = {
      type: "llamacpp",
      baseUrl: "http://other-server:8080",
      apiKeyEnv: isolatedProviderCredentialName(connection.newProviderId),
    };
    await fixture.writeConfig(config);
    const env = await fixture.readEnv();
    await expect(
      service.enable({ ...connection, useApiKey: true, apiKey: key }, signal()),
    ).rejects.toMatchObject({ code: "embedding_credential_conflict" });
    expect(await fixture.readConfig()).toEqual(config);
    expect(await fixture.readEnv()).toBe(env);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("saved credential completion preserves its custom binding and rejects replacement", async () => {
    const config = await fixture.readConfig();
    config.models.providers.embedding = {
      type: "llamacpp",
      baseUrl: connection.baseUrl,
      apiKeyEnv: "LLAMA_EMBED_FIXTURE_KEY",
    };
    await fixture.writeConfig(config);
    vi.stubEnv("LLAMA_EMBED_FIXTURE_KEY", "");
    await service.enable(
      { providerId: "embedding", model: connection.model, apiKey: key },
      signal(),
    );
    expect((await fixture.readConfig()).models.providers).toEqual(
      config.models.providers,
    );
    await expect(
      service.enable(
        {
          providerId: "embedding",
          model: connection.model,
          apiKey: "different-key",
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "credential_already_configured" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test.each([
    { newProviderId: "__proto__" },
    { newProviderId: "bad/id" },
    { newProviderId: undefined },
    { baseUrl: "http://user:pass@server:8080" },
    { baseUrl: "http://server:8080/v1" },
    { useApiKey: "true" },
    { useApiKey: false, apiKey: key },
    { provider: "ollama" },
    { provider: undefined, providerId: "llamacpp" },
  ])(
    "rejects invalid new connection fields before persistence: %j",
    async (override) => {
      const config = await readFile(fixture.configPath, "utf8");
      const env = await fixture.readEnv();
      await expect(
        service.enable({ ...connection, ...override }, signal()),
      ).rejects.toBeDefined();
      expect(await readFile(fixture.configPath, "utf8")).toBe(config);
      expect(await fixture.readEnv()).toBe(env);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
