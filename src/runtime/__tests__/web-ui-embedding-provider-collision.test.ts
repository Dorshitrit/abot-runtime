import { readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createModelProviderAdapterRegistry,
  type ModelProviderAdapter,
} from "../../model-gateway/index.js";
import { isolatedProviderCredentialName } from "../../web-ui/local-runtime/provider-credential-identity.js";
import { SetupEmbeddingService } from "../../web-ui/local-runtime/setup-embedding-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let service: SetupEmbeddingService;
const embed = vi.fn<NonNullable<ModelProviderAdapter["embed"]>>();
const signal = () => new AbortController().signal;
const existingKey = "fixture-existing-connection-key";
const defaultKey = "fixture-existing-default-key";

beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-fourth-review-20260908/embedding-collisions",
  );
  await writeFile(
    fixture.envPath,
    `${await fixture.readEnv()}\nMODEL_FIXTURE_KEY="${existingKey}"\nOPENAI_API_KEY="${defaultKey}"\n`,
  );
  embed.mockReset();
  embed.mockImplementation(async ({ texts }) => ({
    kind: "embedded",
    modelFingerprint: "fixture:collision",
    vectors: texts.map(() => [0.25, 0.75]),
  }));
  const providerAdapters = createModelProviderAdapterRegistry(
    ["openai", "ollama"].map((type) => ({
      type,
      supportsImageInput: false,
      embed,
      invoke: async () => ({ kind: "raw" as const, body: {} }),
    })),
  );
  service = new SetupEmbeddingService({
    rootDir: fixture.rootDir,
    getConfigPath: () => fixture.configPath,
    providerAdapters,
  });
});

afterEach(async () => fixture.cleanup());

test.each([
  {
    provider: "openai",
    occupied: { type: "ollama", baseUrl: "http://127.0.0.1:19999" },
    connection: { apiKey: "fixture-new-embedding-key" },
  },
  {
    provider: "ollama",
    occupied: { type: "openai", apiKeyEnv: "MODEL_FIXTURE_KEY" },
    connection: { baseUrl: "http://127.0.0.1:19998" },
  },
])(
  "adds $provider under the first unused suffix and reuses the returned identity without changing saved connections",
  async ({ provider, occupied, connection }) => {
    const config = await fixture.readConfig();
    Object.assign(config.models.providers, {
      cloud: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" },
      [provider]: occupied,
      [`${provider}-2`]: { ...occupied },
      [`${provider}-4`]: { ...occupied },
    });
    await fixture.writeConfig(config);
    const providerId = `${provider}-3`;

    const result = await service.enable(
      { provider, model: "fixture-embedding", ...connection },
      signal(),
    );

    expect(result.status).toMatchObject({ enabled: true, providerId });
    expect(embed).toHaveBeenCalledOnce();
    expect(embed.mock.calls[0]![0].profile).toMatchObject({
      providerId,
      provider,
    });
    const saved = await fixture.readConfig();
    expect(saved.models.providers).toEqual({
      ...config.models.providers,
      [providerId]: expect.objectContaining({ type: provider }),
    });
    expect(saved.models.profiles).toEqual(config.models.profiles);
    expect(
      saved.models.embeddingProfiles[result.status.profileId!].provider,
    ).toBe(providerId);
    expect(await fixture.readEnv()).toContain(
      `MODEL_FIXTURE_KEY="${existingKey}"`,
    );
    expect(JSON.stringify(result)).not.toContain(existingKey);
    expect(JSON.stringify(saved)).not.toContain(existingKey);
    const credentials = parse(await fixture.readEnv());
    expect(credentials.OPENAI_API_KEY).toBe(defaultKey);
    if (provider === "openai") {
      const apiKeyEnv = saved.models.providers[providerId].apiKeyEnv;
      expect(apiKeyEnv).not.toBe("OPENAI_API_KEY");
      expect(credentials[apiKeyEnv]).toBe(connection.apiKey);
      expect(JSON.stringify(result)).not.toContain(connection.apiKey);
    }

    const reused = await service.enable(
      { providerId, model: "fixture-embedding" },
      signal(),
    );

    expect(reused.status.providerId).toBe(providerId);
    expect((await fixture.readConfig()).models.providers).toEqual(
      saved.models.providers,
    );
    expect(parse(await fixture.readEnv())).toEqual(credentials);
    expect(embed.mock.calls[1]![0].profile.providerId).toBe(providerId);
  },
);

test("implicit same-adapter selection reuses its existing custom provider and saved credential", async () => {
  const config = await fixture.readConfig();
  config.models.providers.openai = {
    type: "openai",
    apiKeyEnv: "MODEL_FIXTURE_KEY",
    baseUrl: "https://fixture.example/v1",
  };
  await fixture.writeConfig(config);
  const result = await service.enable(
    { provider: "openai", model: "fixture-embedding" },
    signal(),
  );
  expect(result.status.providerId).toBe("openai");
  expect((await fixture.readConfig()).models.providers).toEqual(
    config.models.providers,
  );
  expect(embed.mock.calls[0]![0].profile.providerId).toBe("openai");
  expect(process.env.MODEL_FIXTURE_KEY).toBe(existingKey);
  expect(await fixture.readEnv()).toContain(
    `MODEL_FIXTURE_KEY="${existingKey}"`,
  );
  expect(JSON.stringify(result)).not.toContain(existingKey);
});

test("a collision-created OpenAI connection copies a saved default key into its isolated binding without changing the source", async () => {
  const config = await fixture.readConfig();
  config.models.providers.openai = {
    type: "ollama",
    baseUrl: "http://127.0.0.1:19999",
  };
  config.models.providers.cloud = {
    type: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
  };
  await fixture.writeConfig(config);

  const result = await service.enable(
    { provider: "openai", model: "fixture-embedding" },
    signal(),
  );

  expect(result.status.providerId).toBe("openai-2");
  const saved = await fixture.readConfig();
  const apiKeyEnv = saved.models.providers["openai-2"].apiKeyEnv;
  expect(apiKeyEnv).toBe(isolatedProviderCredentialName("openai-2"));
  const credentials = parse(await fixture.readEnv());
  expect(credentials[apiKeyEnv]).toBe(defaultKey);
  expect(credentials.OPENAI_API_KEY).toBe(defaultKey);
  expect(saved.models.providers.cloud).toEqual(config.models.providers.cloud);
  expect(JSON.stringify(result)).not.toContain(defaultKey);
});

test("a preexisting isolated credential cannot be replaced while creating a collision provider", async () => {
  const config = await fixture.readConfig();
  config.models.providers.openai = {
    type: "ollama",
    baseUrl: "http://127.0.0.1:19999",
  };
  await fixture.writeConfig(config);
  const apiKeyEnv = isolatedProviderCredentialName("openai-2");
  await writeFile(
    fixture.envPath,
    `${await fixture.readEnv()}${apiKeyEnv}="${existingKey}"\n`,
  );
  const credentials = await fixture.readEnv();

  const failure = await service
    .enable(
      {
        provider: "openai",
        model: "fixture-embedding",
        apiKey: "fixture-replacement-key",
      },
      signal(),
    )
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: "credential_already_configured" });
  expect(failure).not.toHaveProperty("savedProvider");
  expect(await fixture.readConfig()).toEqual(config);
  expect(await fixture.readEnv()).toBe(credentials);
  expect(embed).not.toHaveBeenCalled();
});

test("a new isolated embedding binding cannot share another configured provider even when their key values match", async () => {
  const config = await fixture.readConfig();
  const apiKeyEnv = isolatedProviderCredentialName("openai-2");
  config.models.providers.openai = {
    type: "ollama",
    baseUrl: "http://127.0.0.1:19999",
  };
  config.models.providers.cloud = { type: "openai", apiKeyEnv };
  await fixture.writeConfig(config);
  await writeFile(
    fixture.envPath,
    `${await fixture.readEnv()}${apiKeyEnv}="${existingKey}"\n`,
  );
  const credentials = await fixture.readEnv();
  const originalConfig = await readFile(fixture.configPath, "utf8");

  const failure = await service
    .enable(
      { provider: "openai", model: "fixture-embedding", apiKey: existingKey },
      signal(),
    )
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({
    code: "embedding_credential_conflict",
    statusCode: 409,
  });
  expect(failure).not.toHaveProperty("savedProvider");
  expect(await readFile(fixture.configPath, "utf8")).toBe(originalConfig);
  expect(await fixture.readEnv()).toBe(credentials);
  expect(embed).not.toHaveBeenCalled();
});
