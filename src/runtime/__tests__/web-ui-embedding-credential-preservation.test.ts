import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parse } from "dotenv";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createModelProviderAdapterRegistry,
  type ModelProviderAdapter,
} from "../../model-gateway/index.js";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import { SetupEmbeddingService } from "../../web-ui/local-runtime/setup-embedding-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

type ConnectionMode = "existing" | "implicit" | "new-default";
let fixture: ModelSetupFixture;
let service: SetupEmbeddingService;
const embed = vi.fn<NonNullable<ModelProviderAdapter["embed"]>>();
const existingKey = "fixture-preserved-chat-key";
const replacementKey = "fixture-replacement-embedding-key";
const signal = () => new AbortController().signal;
const providerAdapters = createModelProviderAdapterRegistry([
  {
    type: "openai",
    supportsImageInput: false,
    embed,
    invoke: async () => ({ kind: "raw" as const, body: {} }),
  },
]);

beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-fifth-review-20260908/embedding-credentials",
  );
  embed.mockReset();
  embed.mockImplementation(async ({ texts }) => ({
    kind: "embedded",
    modelFingerprint: "fixture:preserved-credential",
    vectors: texts.map(() => [0.25, 0.75]),
  }));
  service = new SetupEmbeddingService({
    rootDir: fixture.rootDir,
    getConfigPath: () => fixture.configPath,
    providerAdapters,
  });
});

afterEach(async () => fixture.cleanup());

async function configureSharedConnection(
  mode: ConnectionMode,
  savedKey = existingKey,
) {
  const config = await fixture.readConfig();
  const apiKeyEnv =
    mode === "existing" ? "MODEL_FIXTURE_KEY" : "OPENAI_API_KEY";
  const providerId = mode === "existing" ? "embedding" : "openai";
  const provider = { type: "openai", apiKeyEnv };
  config.models.providers.chatcloud = { ...provider };
  for (const profile of Object.values(config.models.profiles) as Record<
    string,
    unknown
  >[])
    profile.provider = "chatcloud";
  if (mode !== "new-default") config.models.providers[providerId] = provider;
  await fixture.writeConfig(config);
  if (savedKey)
    await writeFile(
      fixture.envPath,
      `${await fixture.readEnv()}${apiKeyEnv}="${savedKey}"\n`,
    );
  const selection =
    mode === "existing" ? { providerId } : { provider: "openai" };
  return { apiKeyEnv, providerId, selection, config };
}

test.each<ConnectionMode>(["existing", "implicit", "new-default"])(
  "%s embedding setup rejects replacement of a credential shared with chat before any persistence or probe",
  async (mode) => {
    const { apiKeyEnv, selection } = await configureSharedConnection(mode);
    const beforeConfig = await readFile(fixture.configPath, "utf8");
    const beforeCredentials = await fixture.readEnv();
    const inherited = process.env[apiKeyEnv];

    const failure = await service
      .enable(
        { ...selection, model: "fixture-embedding", apiKey: replacementKey },
        signal(),
      )
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "credential_already_configured",
      statusCode: 409,
    });
    expect(String(failure)).not.toContain(existingKey);
    expect(String(failure)).not.toContain(replacementKey);
    expect(failure).not.toHaveProperty("savedProvider");
    expect(await readFile(fixture.configPath, "utf8")).toBe(beforeConfig);
    expect(await fixture.readEnv()).toBe(beforeCredentials);
    expect(process.env[apiKeyEnv]).toBe(inherited);
    expect(embed).not.toHaveBeenCalled();
  },
);

test.each([
  {
    mode: "existing" as const,
    apiKey: existingKey,
    savedKey: existingKey,
    label: "equal custom key",
  },
  {
    mode: "implicit" as const,
    apiKey: undefined,
    savedKey: existingKey,
    label: "omitted saved default key",
  },
  {
    mode: "existing" as const,
    apiKey: existingKey,
    savedKey: "",
    label: "missing custom key",
  },
  {
    mode: "new-default" as const,
    apiKey: existingKey,
    savedKey: "",
    label: "missing default key on first creation",
  },
])(
  "allows $label without changing the chat connection",
  async ({ mode, apiKey, savedKey }) => {
    const { apiKeyEnv, providerId, selection, config } =
      await configureSharedConnection(mode, savedKey);

    const result = await service.enable(
      {
        ...selection,
        model: "fixture-embedding",
        ...(apiKey ? { apiKey } : {}),
      },
      signal(),
    );

    expect(result.status).toMatchObject({ enabled: true, providerId });
    expect(embed).toHaveBeenCalledOnce();
    expect(embed.mock.calls[0]![0].profile.providerId).toBe(providerId);
    const after = await fixture.readConfig();
    expect(after.models.providers.chatcloud).toEqual(
      config.models.providers.chatcloud,
    );
    expect(after.models.profiles).toEqual(config.models.profiles);
    expect(parse(await fixture.readEnv())[apiKeyEnv]).toBe(existingKey);
    expect(process.env[apiKeyEnv]).toBe(existingKey);
    expect((await stat(fixture.envPath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(existingKey);
  },
);

test("HTTP rejects a changed shared credential without a saved receipt and accepts retry using the saved key", async () => {
  const { selection, apiKeyEnv } = await configureSharedConnection("existing");
  const beforeConfig = await readFile(fixture.configPath, "utf8");
  const beforeCredentials = await fixture.readEnv();
  const backend = new LocalRuntimeWebBackend({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
    providerAdapters,
  });
  const server = createServer((request, response) => {
    void backend.handleHttp(
      request,
      response,
      new URL(request.url!, "http://localhost").pathname,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (apiKey?: string) =>
    fetch(`${origin}/web-api/runtime/setup/embedding`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        ...selection,
        model: "fixture-embedding",
        ...(apiKey ? { apiKey } : {}),
      }),
    });
  try {
    const response = await post(replacementKey);
    const raw = await response.text();
    expect(response.status).toBe(409);
    expect(JSON.parse(raw)).toMatchObject({
      ok: false,
      error: "credential_already_configured",
      providerSaved: false,
    });
    expect(JSON.parse(raw)).not.toHaveProperty("savedProvider");
    expect(raw).not.toContain(existingKey);
    expect(raw).not.toContain(replacementKey);
    expect(await readFile(fixture.configPath, "utf8")).toBe(beforeConfig);
    expect(await fixture.readEnv()).toBe(beforeCredentials);
    expect(embed).not.toHaveBeenCalled();

    const retry = await post();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      ok: true,
      status: { enabled: true, providerId: "embedding" },
    });
    expect(parse(await fixture.readEnv())[apiKeyEnv]).toBe(existingKey);
    expect(embed).toHaveBeenCalledOnce();
  } finally {
    await backend.stop();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
