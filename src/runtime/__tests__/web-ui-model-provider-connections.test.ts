import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatGptAccount } from "../../provider-auth/chatgpt/contracts.js";
import { readConfigFileSnapshot } from "../adapters/config-file-transaction.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

const { listAccounts } = vi.hoisted(() => ({
  listAccounts: vi.fn<() => Promise<ChatGptAccount[]>>(),
}));
vi.mock("../../provider-auth/chatgpt/service.js", () => ({
  getChatGptAuthService: () => ({ listAccounts }),
}));

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(tmpdir());
  listAccounts.mockReset();
});
afterEach(async () => fixture.cleanup());

const revision = async () =>
  (await readConfigFileSnapshot(fixture.configPath)).revision;
const configBytes = () => readFile(fixture.configPath, "utf8");
async function registerProvider(id: string, provider: Record<string, unknown>) {
  const config = await fixture.readConfig();
  config.models.providers[id] = provider;
  await fixture.writeConfig(config);
}
async function update(providerId: string, fields: Record<string, unknown>) {
  return fixture.service.updateProvider({
    providerId,
    expectedRevision: await revision(),
    ...fields,
  });
}
async function remove(providerId: string) {
  return fixture.service.removeProvider({
    providerId,
    expectedRevision: await revision(),
  });
}

test("edits the saved connection in use without touching profiles, defaults, or adapter settings", async () => {
  const before = await fixture.readConfig();
  before.models.providers.ollama.settings = { extension: "retain" };
  await fixture.writeConfig(before);
  const profile = await fixture.readModelProfile("default");
  const fields = { baseUrl: "https://host.EXAMPLE:9001/", keepAlive: "20m" };
  await expect(update("ollama", fields)).resolves.toEqual({
    providerId: "ollama",
    restartRequired: true,
  });
  Object.assign(before.models.providers.ollama, {
    baseUrl: "https://host.example:9001",
    keepAlive: "20m",
  });
  expect(await fixture.readConfig()).toEqual(before);
  expect(await fixture.readModelProfile("default")).toEqual(profile);
  await update("ollama", { keepAlive: "" });
  delete before.models.providers.ollama.keepAlive;
  expect(await fixture.readConfig()).toEqual(before);
});

test.each(["llamacpp", "openai"])(
  "changes only the %s credential binding and preserves saved credentials",
  async (type) => {
    const previous = {
      type,
      apiKeyEnv: "MODEL_FIXTURE_KEY",
      settings: { custom: true },
    };
    await registerProvider("custom", previous);
    await writeFile(
      fixture.envPath,
      "MODEL_FIXTURE_KEY=fixture-secret\nNEW_BINDING=second-secret\n",
    );
    const env = await fixture.readEnv();
    await expect(
      update("custom", { apiKeyEnv: "NEW_BINDING" }),
    ).resolves.toEqual({ providerId: "custom", restartRequired: true });
    expect((await fixture.readConfig()).models.providers.custom).toEqual({
      ...previous,
      apiKeyEnv: "NEW_BINDING",
    });
    await update("custom", { apiKeyEnv: "" });
    expect((await fixture.readConfig()).models.providers.custom).toEqual({
      type,
      settings: previous.settings,
    });
    expect(await fixture.readEnv()).toBe(env);
  },
);

test("preserves a bound key and existing extension fields when moving only the llama.cpp address", async () => {
  const previous = {
    type: "llamacpp",
    apiKeyEnv: "MODEL_FIXTURE_KEY",
    baseUrl: "http://old:8800",
    keepAlive: "legacy",
  };
  await registerProvider("worker", previous);
  await update("worker", { baseUrl: "http://new:8801/" });
  expect((await fixture.readConfig()).models.providers.worker).toEqual({
    ...previous,
    baseUrl: "http://new:8801",
  });
});

test("preserves an implicit endpoint on a saved Ollama connection", async () => {
  await registerProvider("deferred", { type: "ollama" });
  await update("deferred", { keepAlive: "0" });
  expect((await fixture.readConfig()).models.providers.deferred).toEqual({
    type: "ollama",
    keepAlive: "0",
  });
});

test("switches only to a saved, connected, plan-enabled ChatGPT account", async () => {
  const previousRef = "56f84b27-dbd8-4dac-97fe-7daa7792dc23";
  const nextRef = "a87285ce-649f-4f0b-891e-d1168e82fc1d";
  const previous = {
    type: "openai-chatgpt",
    settings: { accountRef: previousRef },
  };
  await registerProvider("account", previous);
  const before = await configBytes();
  const account: ChatGptAccount = {
    accountRef: nextRef,
    label: "Test",
    status: "connected",
    planEnabled: true,
    planWelcomeAcknowledged: true,
  };
  listAccounts.mockResolvedValueOnce([{ ...account, planEnabled: false }]);
  await expect(
    update("account", { accountRef: nextRef }),
  ).rejects.toMatchObject({
    code: "model_account_unavailable",
    statusCode: 409,
  });
  expect(await configBytes()).toBe(before);
  listAccounts.mockResolvedValueOnce([account]);
  await update("account", { accountRef: nextRef });
  expect((await fixture.readConfig()).models.providers.account).toEqual({
    type: previous.type,
    settings: { accountRef: nextRef },
  });
});

test.each([
  ["ollama", { apiKey: "secret" }],
  ["ollama", { apiKeyEnv: "HTTP_KEY" }],
  ["ollama", { type: "llamacpp" }],
  ["ollama", { id: "renamed" }],
  ["llamacpp", { keepAlive: "5m" }],
  ["openai", { baseUrl: "https://outside" }],
  ["openai-chatgpt", { apiKeyEnv: "HTTP_KEY" }],
  ["ollama", { accountRef: "unexpected" }],
  ["ollama", { baseUrl: "https://name:secret@host/" }],
  ["ollama", { baseUrl: "https://host/path" }],
  ["llamacpp", { baseUrl: null }],
  ["openai", { apiKeyEnv: "KEY=value" }],
  ["custom", { settings: {} }],
] as const)(
  "rejects unsupported or unsafe settings for %s",
  async (type, fields) => {
    await registerProvider("custom", { type });
    const before = await configBytes();
    await expect(update("custom", fields)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await configBytes()).toBe(before);
  },
);

test.each(["linked chat", "inline chat", "embedding"])(
  "rejects a provider used by a %s profile",
  async (kind) => {
    await registerProvider("other", { type: "ollama" });
    const config = await fixture.readConfig();
    const profile = await fixture.readModelProfile("default");
    if (kind === "linked chat")
      await fixture.writeModelProfile("default", {
        ...profile,
        provider: "other",
      });
    if (kind === "inline chat")
      config.models.profiles.another = { ...profile, provider: "other" };
    if (kind === "embedding")
      config.models.embeddingProfiles = {
        search: { provider: "other", model: "embed" },
      };
    await fixture.writeConfig(config);
    const before = await configBytes();
    await expect(remove("other")).rejects.toMatchObject({
      code: "model_provider_in_use",
      statusCode: 409,
    });
    expect(await configBytes()).toBe(before);
  },
);

test("removes just the unused provider declaration, including custom and shared-credential connections", async () => {
  await registerProvider("retained", {
    type: "openai",
    apiKeyEnv: "MODEL_FIXTURE_KEY",
  });
  await registerProvider("custom", {
    type: "custom",
    apiKeyEnv: "MODEL_FIXTURE_KEY",
  });
  const expected = await fixture.readConfig();
  const env = await fixture.readEnv();
  await expect(remove("custom")).resolves.toEqual({
    providerId: "custom",
    restartRequired: true,
  });
  delete expected.models.providers.custom;
  expect(await fixture.readConfig()).toEqual(expected);
  expect(await fixture.readEnv()).toBe(env);
});

test("rejects the last connection, missing revision, unknown Id and unexpected removal fields", async () => {
  const before = await configBytes();
  await expect(remove("ollama")).rejects.toMatchObject({
    code: "model_provider_required",
    statusCode: 409,
  });
  await expect(
    fixture.service.updateProvider({ providerId: "ollama", keepAlive: "5m" }),
  ).rejects.toMatchObject({ statusCode: 428 });
  await expect(remove("constructor")).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    fixture.service.removeProvider({
      providerId: "ollama",
      expectedRevision: await revision(),
      apiKey: "secret",
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(await configBytes()).toBe(before);
});

test("validates the effective candidate before replacing the file", async () => {
  const profile = await fixture.readModelProfile("default");
  await fixture.writeModelProfile("default", {
    ...profile,
    provider: "absent",
  });
  const before = await configBytes();
  await expect(update("ollama", { keepAlive: "2m" })).rejects.toMatchObject({
    code: "model_provider_invalid_config",
  });
  expect(await configBytes()).toBe(before);
});

test("serializes competing edits and rejects stale deletions using the runtime revision", async () => {
  await registerProvider("unused", { type: "ollama" });
  const expectedRevision = await revision();
  const requests = ["5m", "8m"].map((keepAlive) =>
    fixture.service.updateProvider({
      providerId: "unused",
      expectedRevision,
      keepAlive,
    }),
  );
  const results = await Promise.allSettled(requests);
  expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(results.find((entry) => entry.status === "rejected")).toMatchObject({
    reason: { code: "config_changed" },
  });
  await expect(
    fixture.service.removeProvider({ providerId: "unused", expectedRevision }),
  ).rejects.toMatchObject({ code: "config_changed" });
  expect((await fixture.readConfig()).models.providers.unused).toHaveProperty(
    "keepAlive",
  );
});
