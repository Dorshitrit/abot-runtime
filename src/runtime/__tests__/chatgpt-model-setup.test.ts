import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";
import { parseModelSetupInput } from "../../web-ui/local-runtime/model-setup-input.js";
import { parseRuntimeSetupInput } from "../../web-ui/local-runtime/runtime-setup-input.js";
import { loadRuntimeConfig } from "../config.js";
import type { ChatGptAccount } from "../../provider-auth/chatgpt/contracts.js";

const { listAccounts } = vi.hoisted(() => ({
  listAccounts: vi.fn<() => Promise<ChatGptAccount[]>>(),
}));
vi.mock("../../provider-auth/chatgpt/service.js", () => ({
  getChatGptAuthService: () => ({ listAccounts }),
}));
const accountRef = "56f84b27-dbd8-4dac-97fe-7daa7792dc23";
const secondRef = "a87285ce-649f-4f0b-891e-d1168e82fc1d";
const artifacts = resolve(
  ".codex/artifacts/continue-with-chatgpt-20261028/setup-tests",
);
let fixture: ModelSetupFixture | undefined;
let rootDir = "";
let configPath: string | undefined;
let setup: RuntimeSetupService;
const account: ChatGptAccount = {
  accountRef,
  label: "Test account",
  status: "connected",
  planEnabled: true,
  planWelcomeAcknowledged: true,
};
const addition = {
  profileId: "chatgpt",
  model: "account-model",
  contextWindowTokens: 32768,
  supportsThinking: true,
  newProvider: { id: "chatgpt-account", type: "openai-chatgpt", accountRef },
};

beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "setup-"));
  configPath = undefined;
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  listAccounts.mockResolvedValue([account]);
  setup = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    configure: (path) => {
      configPath = path;
    },
    activate: async () => ({ status: "ready" }),
  });
});
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

test("initial setup and revision edit retain the exact account binding outside profile context", async () => {
  const first = await setup.save({
    provider: "openai-chatgpt",
    accountRef,
    model: "account-model",
    contextWindowTokens: 32768,
    supportsThinking: true,
    deferActivation: true,
  });
  expect(first.setup.existingModel).toMatchObject({
    provider: "openai-chatgpt",
    accountRef,
    authentication: "chatgpt",
  });
  const config = loadRuntimeConfig({ rootDir, configPath });
  expect(config.models?.providers?.["openai-chatgpt"]).toEqual({
    type: "openai-chatgpt",
    settings: { accountRef },
  });
  expect(config.models?.profiles?.default).toMatchObject({
    model: "account-model",
    contextWindowTokens: 32768,
    supportsThinking: true,
  });
  const profile = JSON.parse(
    await readFile(join(rootDir, "local/models/default.config.json"), "utf8"),
  );
  expect(profile.execution.policy).toBe("execution-agent-v1");
  expect(JSON.stringify(profile)).not.toContain(accountRef);
  expect(await readFile(join(rootDir, ".env"), "utf8")).not.toContain(
    accountRef,
  );
  listAccounts.mockResolvedValue([
    account,
    { ...account, accountRef: secondRef },
  ]);
  const edited = await setup.save({
    provider: "openai-chatgpt",
    accountRef: secondRef,
    model: "account-second",
    contextWindowTokens: 65536,
    supportsThinking: false,
    deferActivation: true,
    connectionRevision: first.setup.editableConnection!.revision,
  });
  expect(edited.setup.existingModel).toMatchObject({
    accountRef: secondRef,
    contextWindowTokens: 65536,
    supportsThinking: false,
  });
  expect(
    loadRuntimeConfig({ rootDir, configPath }).models?.providers?.[
      "openai-chatgpt"
    ]?.settings,
  ).toEqual({ accountRef: secondRef });
});

test("add-model and retry preserve existing providers/defaults and bind another model to the same account", async () => {
  fixture = await createModelSetupFixture(artifacts);
  const before = await fixture.readConfig();
  const env = await fixture.readEnv();
  await fixture.service.add(addition);
  await expect(fixture.service.add(addition)).resolves.toMatchObject({
    model: { provider: "openai-chatgpt" },
  });
  await fixture.service.add({
    profileId: "second-chatgpt",
    model: "second-model",
    providerId: "chatgpt-account",
    contextWindowTokens: 32768,
  });
  const after = await fixture.readConfig();
  expect(after.models.providers.ollama).toEqual(before.models.providers.ollama);
  expect(after.models.profiles.default).toEqual(before.models.profiles.default);
  expect(after.requestRunner).toEqual(before.requestRunner);
  expect(after.models.providers["chatgpt-account"]).toEqual({
    type: "openai-chatgpt",
    settings: { accountRef },
  });
  expect(await fixture.readEnv()).toBe(env);
  expect(
    (await fixture.service.catalog()).providers.find(
      (entry) => entry.id === "chatgpt-account",
    ),
  ).toMatchObject({
    accountRef,
    authentication: "chatgpt",
    requiresApiKey: false,
    credentialConfigured: false,
  });
});

test.each(["signed_out", "identity_only", "reauth_required", "missing"])(
  "rejects %s accounts without writing configuration",
  async (status) => {
    listAccounts.mockResolvedValue(
      status === "missing"
        ? []
        : [
            {
              ...account,
              status: status as ChatGptAccount["status"],
              planEnabled: false,
            },
          ],
    );
    await expect(
      setup.save({ provider: "openai-chatgpt", accountRef, model: "test" }),
    ).rejects.toMatchObject({ code: "setup_account_unavailable" });
    await expect(
      readFile(join(rootDir, "local/runtime.config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    fixture = await createModelSetupFixture(artifacts);
    const before = await fixture.readConfig();
    await expect(fixture.service.add(addition)).rejects.toMatchObject({
      code: "model_account_unavailable",
    });
    expect(await fixture.readConfig()).toEqual(before);
  },
);

test.each([
  { accountRef: undefined },
  { accountRef: "not-an-account" },
  { baseUrl: "https://elsewhere.example" },
  { apiKeyEnv: "OPENAI_API_KEY" },
  { useApiKey: true },
])(
  "rejects credential or endpoint overrides in the ChatGPT provider: %j",
  (extra) => {
    expect(() =>
      parseModelSetupInput({
        ...addition,
        newProvider: { ...addition.newProvider, ...extra },
      }),
    ).toThrow();
  },
);

test.each([
  { apiKey: "synthetic-secret" },
  { baseUrl: "https://elsewhere.example" },
  { accountRef: undefined },
])("rejects invalid initial connection before writes: %j", (extra) => {
  expect(() =>
    parseRuntimeSetupInput({
      provider: "openai-chatgpt",
      accountRef,
      model: "test",
      ...extra,
    }),
  ).toThrow();
});

test("does not reinterpret API-key and Ollama inputs as account connections", () => {
  expect(
    parseRuntimeSetupInput({
      provider: "openai",
      model: "test",
      apiKey: "synthetic-key",
    }),
  ).toEqual({ provider: "openai", model: "test", apiKey: "synthetic-key" });
  expect(() =>
    parseRuntimeSetupInput({ provider: "ollama", model: "test", accountRef }),
  ).toThrow();
  expect(() =>
    parseModelSetupInput({
      ...addition,
      newProvider: { id: "cloud", type: "openai", accountRef },
    }),
  ).toThrow();
});
