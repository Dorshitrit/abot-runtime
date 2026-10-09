import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  captureModelGatewayConfiguration,
  configureModelGateway,
} from "../../model-gateway/server/configuration.js";
import type { ModelGatewayHandlerOptions } from "../../model-gateway/server/contracts.js";
import * as debugLogger from "../observability/debug-logger.js";
import * as modelIoTrace from "../../model-gateway/model-io-trace.js";
import { invalidateRequestRunnerConfig } from "../config/runner/loader.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
function capture(options: ModelGatewayHandlerOptions = {}) {
  return captureModelGatewayConfiguration({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    ...options,
  });
}

beforeEach(async () => {
  for (const name of [
    "LLM_RUNTIME_PROFILE",
    "LLM_RUNTIME_SHARED_DIR",
    "MODEL_GATEWAY_TRACE_FILE",
    "MODEL_GATEWAY_MODEL_IO_TRACE_FILE",
    "OLLAMA_URL",
    "OLLAMA_NUM_PREDICT",
    "OPENAI_BASE_URL",
  ])
    vi.stubEnv(name, "");
  vi.stubEnv("MODEL_GATEWAY_URL", "http://127.0.0.1:3000");
  fixture = await createModelSetupFixture(
    ".codex/artifacts/plugin-only-activation-20261007/configuration-snapshot",
  );
});

afterEach(async () => {
  debugLogger.processDebugLogger.reset();
  await fixture.cleanup();
});

test("plugin selection and JSON key order leave the gateway snapshot unchanged", async () => {
  const previous = capture();
  const config = await fixture.readConfig();
  config.plugins = { enabled: true, deny: ["example-plugin"] };
  await fixture.writeConfig(
    Object.fromEntries(Object.entries(config).reverse()),
  );
  const profile = await fixture.readModelProfile("default");
  await fixture.writeModelProfile(
    "default",
    Object.fromEntries(Object.entries(profile).reverse()),
  );
  expect(capture()).toBe(previous);
  expect(previous).toMatch(/^[a-f0-9]{64}$/);
});

test("linked model edits change the snapshot at the same source path", async () => {
  const previous = capture();
  const profile = await fixture.readModelProfile("default");
  await fixture.writeModelProfile("default", {
    ...profile,
    model: "changed-model",
  });
  expect(capture()).not.toBe(previous);
});

test("provider connection changes enter the projection", async () => {
  const previous = capture();
  const config = await fixture.readConfig();
  const providerId = Object.keys(config.models.providers)[0]!;
  config.models.providers[providerId].baseUrl = "http://127.0.0.1:11439";
  await fixture.writeConfig(config);
  expect(capture()).not.toBe(previous);
});

test("fresh linked runner model defaults change the snapshot; runtime timeout edits do not", async () => {
  await fixture.service.add({
    profileId: "later",
    providerId: "ollama",
    model: "later-model",
  });
  const previous = capture();
  const config = await fixture.readConfig();
  const runnerPath = resolve(
    dirname(fixture.configPath),
    config.requestRunner.configRef,
  );
  const runner = JSON.parse(await readFile(runnerPath, "utf8"));
  runner.stepDefaults.timeoutMs = 54321;
  await writeFile(runnerPath, JSON.stringify(runner));
  invalidateRequestRunnerConfig({ configPath: runnerPath });
  expect(capture()).toBe(previous);
  runner.models.defaults.profileId = "later";
  await writeFile(runnerPath, JSON.stringify(runner));
  invalidateRequestRunnerConfig({ configPath: runnerPath });
  expect(capture()).not.toBe(previous);
});

test.each([
  ["MODEL_GATEWAY_URL", "http://127.0.0.1:3100"],
  ["MODEL_GATEWAY_TRACE_FILE", "/tmp/changed-gateway-trace.jsonl"],
  ["MODEL_GATEWAY_MODEL_IO_TRACE_FILE", "/tmp/changed-model-trace.jsonl"],
  ["LLM_RUNTIME_SHARED_DIR", "/tmp/changed-shared"],
  ["OLLAMA_URL", "http://127.0.0.1:11435"],
  ["OLLAMA_NUM_PREDICT", "1234"],
  ["OPENAI_BASE_URL", "https://example.invalid/v1"],
])("captures the effective %s dependency", (name, value) => {
  const previous = capture();
  vi.stubEnv(name, value);
  expect(capture()).not.toBe(previous);
});

test("logging and default environment shared paths enter the projection", async () => {
  const previous = capture();
  const config = await fixture.readConfig();
  config.logging = { enabled: false, rotation: { maxFiles: 17 } };
  await fixture.writeConfig(config);
  const changedLogging = capture();
  expect(changedLogging).not.toBe(previous);
  const defaultProfile = config.environment.default;
  config.environment.profiles[defaultProfile].paths = {
    ...config.environment.profiles[defaultProfile].paths,
    sharedDir: "changed-shared-directory",
  };
  await fixture.writeConfig(config);
  expect(capture()).not.toBe(changedLogging);
});

test("credential dependencies affect only the opaque hash", () => {
  const options = {
    modelPolicy: {
      providers: { custom: { type: "openai", apiKeyEnv: "MODEL_FIXTURE_KEY" } },
    },
  };
  const previous = capture(options);
  vi.stubEnv("MODEL_FIXTURE_KEY", "fixture-secret-never-in-snapshot");
  const changed = capture(options);
  expect(changed).not.toBe(previous);
  expect(changed).toMatch(/^[a-f0-9]{64}$/);
  expect(changed).not.toContain("fixture-secret");
});

test("explicit provider options override environment fallback values", () => {
  const options = { ollamaUrl: "http://127.0.0.1:11436" };
  const previous = capture(options);
  vi.stubEnv("OLLAMA_URL", "http://127.0.0.1:11437");
  expect(capture(options)).toBe(previous);
  expect(capture({ ollamaUrl: "http://127.0.0.1:11438" })).not.toBe(previous);
});

test("opaque adapter registries and additional adapters fail closed", () => {
  const adapter = {
    type: "custom",
    supportsImageInput: false,
    invoke: vi.fn(),
  };
  expect(
    capture({
      providerAdapters: { list: () => [adapter], resolve: () => adapter },
    }),
  ).toBeNull();
  expect(capture({ additionalProviderAdapters: [adapter] })).toBeNull();
});

test("capture leaves loggers untouched and shares the configured gateway policy", () => {
  const debug = vi
    .spyOn(debugLogger, "configureDebugLogger")
    .mockImplementation(() => {});
  const modelIo = vi
    .spyOn(modelIoTrace, "configureModelIoTrace")
    .mockImplementation(() => {});
  capture();
  expect(debug).not.toHaveBeenCalled();
  expect(modelIo).not.toHaveBeenCalled();
  const options = { rootDir: fixture.rootDir, configPath: fixture.configPath };
  const policy = configureModelGateway(options);
  expect(capture({ modelPolicy: policy })).toBe(capture());
  expect(debug).toHaveBeenCalledOnce();
  expect(modelIo).toHaveBeenCalledOnce();
});
