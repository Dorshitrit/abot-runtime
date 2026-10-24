import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { createModelSetupFixture, type ModelSetupFixture } from "./support/model-setup-fixture.js";
import { isolatedProviderCredentialName } from "../../web-ui/local-runtime/provider-credential-identity.js";
import * as dashboard from "../../web-ui/config-dashboard-backend.js";
import { loadRuntimeConfig } from "../config.js";

const artifacts = resolve(".codex/artifacts/llamacpp-setup-20261019");
let rootDir = "";
let configPath: string | undefined;
let setup: RuntimeSetupService;
let fixture: ModelSetupFixture | undefined;
const activated = vi.fn(async () => ({ status: "ready" as const }));

beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "setup-"));
  configPath = undefined;
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv(isolatedProviderCredentialName("llamacpp"), "");
  activated.mockClear();
  setup = new RuntimeSetupService({
    rootDir, getConfigPath: () => configPath,
    configure: (path) => { configPath = path; },
    activate: activated,
  });
});
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

describe("llama.cpp first-class setup", () => {
  test.each(["openai", "ollama", "llamacpp"])("persists explicit thinking support for initial %s setup and revision edits", async (provider) => {
    const first = await setup.save({ provider, model: "registered-model", supportsThinking: true, deferActivation: true,
      ...(provider === "openai" ? { apiKey: "synthetic-registration-key" } : {}) });
    expect(first.setup.existingModel?.supportsThinking).toBe(true);
    const edited = await setup.save({ provider, model: "registered-model", supportsThinking: false,
      deferActivation: true, connectionRevision: first.setup.editableConnection!.revision });
    expect(edited.setup.existingModel?.supportsThinking).toBe(false);
    expect(loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default.supportsThinking).toBe(false);
  });
  test("creates a no-key text-only profile and reports ready without generating", async () => {
    const result = await setup.save({ provider: "llamacpp", model: "local-gemma", deferActivation: true });
    const loaded = loadRuntimeConfig({ rootDir, configPath });
    expect(loaded.models?.providers?.llamacpp).toMatchObject({ type: "llamacpp", baseUrl: "http://127.0.0.1:8080" });
    expect(loaded.models?.providers?.llamacpp).not.toHaveProperty("apiKeyEnv");
    expect(loaded.models?.profiles?.default).toMatchObject({ supportsThinking: false, capabilities: { inputModalities: ["text"] } });
    expect(loaded.models?.profiles?.default.generation?.reasoningBudget).toBeUndefined();
    expect(result.setup.existingModel).toMatchObject({ provider: "llamacpp", supportsThinking: false });
    expect(activated).not.toHaveBeenCalled();
  });

  test("preserves a token budget through reload and revision-bound edit to server default", async () => {
    const first = await setup.save({
      provider: "llamacpp", model: "local-gemma", supportsThinking: true,
      reasoningBudget: { mode: "tokens", tokens: 512 }, deferActivation: true,
    });
    expect((await setup.status()).existingModel).toMatchObject({
      supportsThinking: true, reasoningBudget: { mode: "tokens", tokens: 512 },
    });
    const revision = first.setup.editableConnection!.revision;
    await setup.save({
      provider: "llamacpp", model: "local-gemma", supportsThinking: true,
      reasoningBudget: { mode: "server-default" }, connectionRevision: revision, deferActivation: true,
    });
    expect(loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default.generation?.reasoningBudget)
      .toEqual({ mode: "server-default" });
    await expect(setup.save({
      provider: "llamacpp", model: "stale", connectionRevision: revision,
    })).rejects.toMatchObject({ code: "setup_configuration_changed" });
  });

  test("stores an optional key under its isolated binding and completes missing bound credentials", async () => {
    const keyName = isolatedProviderCredentialName("llamacpp");
    const result = await setup.save({
      provider: "llamacpp", model: "secured", apiKey: "synthetic-llama-key",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-llama-key");
    const raw = await readFile(configPath!, "utf8");
    expect(raw).not.toContain("synthetic-llama-key");
    expect(JSON.parse(raw).models.providers.llamacpp.apiKeyEnv).toBe(keyName);
    expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(keyName + '="synthetic-llama-key"');
    process.env[keyName] = "";
    await writeFile(join(rootDir, ".env"), "LLM_RUNTIME_CONFIG_FILE=" + configPath);
    expect((await setup.status()).status).toBe("required");
    await setup.save({ provider: "llamacpp", model: "secured", baseUrl: "http://127.0.0.1:8080", apiKey: "synthetic-replacement" });
    expect((await setup.status()).status).toBe("ready");
    expect(await readFile(configPath!, "utf8")).toBe(raw);
  });

  test.each([
    { supportsThinking: false, reasoningBudget: { mode: "tokens", tokens: 2 } },
    { supportsThinking: true, reasoningBudget: { mode: "tokens", tokens: -1 } },
    { supportsThinking: true, reasoningBudget: { mode: "tokens", tokens: 1.5 } },
    { supportsThinking: true, reasoningBudget: { mode: "tokens", tokens: 2147483648 } },
  ])("rejects invalid reasoning before writing %j", async (reasoning) => {
    await expect(setup.save({ provider: "llamacpp", model: "test", ...reasoning }))
      .rejects.toMatchObject({ code: "invalid_setup_reasoning" });
    await expect(readFile(join(rootDir, "local/runtime.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reuses a privately committed key after model save fails without changing a no-key choice", async () => {
    fixture = await createModelSetupFixture(artifacts);
    vi.spyOn(dashboard, "saveConfigDashboardFile").mockRejectedValueOnce(new Error("synthetic save failure"));
    const input = {
      profileId: "secured-retry", model: "gemma",
      newProvider: { id: "retry-llama", type: "llamacpp", baseUrl: "http://llama-host:8080", useApiKey: true },
      apiKey: "synthetic-retry-secret",
    };
    await expect(fixture.service.add(input)).rejects.toMatchObject({ credentialSaved: true });
    const { apiKey: _key, ...retry } = input;
    await expect(fixture.service.add(retry)).resolves.toMatchObject({ model: { profileId: "secured-retry" } });
    const providers = (await fixture.readConfig()).models.providers;
    expect(providers["retry-llama"].apiKeyEnv).toBe(isolatedProviderCredentialName("retry-llama"));
    await fixture.service.add({
      profileId: "no-key", model: "gemma",
      newProvider: { id: "no-key-llama", type: "llamacpp", baseUrl: "http://another:8080" },
    });
    expect((await fixture.readConfig()).models.providers["no-key-llama"]).not.toHaveProperty("apiKeyEnv");
  });

  test("adds and retries a secured model without replacing existing model/default/embedding settings", async () => {
    fixture = await createModelSetupFixture(artifacts);
    const before = await fixture.readConfig();
    const input = {
      profileId: "gemma-llama", model: "gemma", supportsThinking: true,
      reasoningBudget: { mode: "tokens", tokens: 128 },
      newProvider: { id: "local-llama", type: "llamacpp", baseUrl: "http://model-host:8080" },
      apiKey: "synthetic-provider-secret",
    };
    await fixture.service.add(input);
    const after = await fixture.readConfig();
    expect(after.models.providers.ollama).toEqual(before.models.providers.ollama);
    expect(after.models.profiles.default).toEqual(before.models.profiles.default);
    expect(after.requestRunner).toEqual(before.requestRunner);
    const profile = await fixture.readModelProfile("gemma-llama");
    expect(profile.generation.reasoningBudget).toEqual({ mode: "tokens", tokens: 128 });
    expect(profile.execution).not.toMatchObject({ policy: "execution-agent-v1" });
    const { apiKey: _key, ...retry } = input;
    await expect(fixture.service.add(retry)).resolves.toMatchObject({ model: { profileId: "gemma-llama" } });
    await fixture.service.add({
      profileId: "same-connection", model: "gemma", providerId: "local-llama",
      supportsThinking: true, reasoningBudget: { mode: "server-default" },
    });
    expect((await fixture.readModelProfile("same-connection")).provider).toBe("local-llama");
    expect(await fixture.readEnv()).not.toContain('OPENAI_API_KEY="synthetic-provider-secret"');
  });
});
