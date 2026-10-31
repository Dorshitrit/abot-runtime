import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as setupFiles from "../../../scripts/runtime-setup-files.js";
import { getConfigDashboardSnapshot, saveConfigDashboardFile } from "../../web-ui/config-dashboard-backend.js";
import { buildModelConfig } from "../../../scripts/runtime-setup-files.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { loadRuntimeConfig } from "../config.js";
import { createModelSetupFixture } from "./support/model-setup-fixture.js";

const artifactRoot = resolve(".codex/artifacts/openai-integration-fixes/prompt-cache-setup");
const exec = promisify(execFile);
let rootDir = "";
let configPath: string | undefined;
const service = () => new RuntimeSetupService({
  rootDir, getConfigPath: () => configPath,
  configure: (path) => { configPath = path; },
  activate: async () => ({ status: "ready" }),
});
const connection = { provider: "openai", model: "fixture-model", apiKey: "fixture-key", deferActivation: true };
beforeEach(async () => {
  await mkdir(artifactRoot, { recursive: true });
  rootDir = await mkdtemp(join(artifactRoot, "case-"));
  configPath = undefined;
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

test("setup persists explicit prompt caching and reloads it for editing, then disables it", async () => {
  const readTemplate = setupFiles.readJsonObject;
  const template = vi.spyOn(setupFiles, "readJsonObject").mockImplementation(async (path) => {
    const value = await readTemplate(path);
    return path.endsWith("examples/models/default.config.json")
      ? { ...value, options: { custom: { retained: true } } } : value;
  });
  const first = await service().save({ ...connection, promptCache: true });
  template.mockRestore();
  expect(loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default.options)
    .toMatchObject({ prompt_cache_options: { mode: "implicit" } });
  expect((await service().status()).existingModel).toMatchObject({ promptCache: true });
  const omitted = await service().save({
    ...connection, model: "edited-model",
    connectionRevision: first.setup.editableConnection!.revision,
  });
  expect(loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default.options)
    .toEqual({ custom: { retained: true }, prompt_cache_options: { mode: "implicit" } });
  await service().save({
    ...connection, promptCache: false,
    connectionRevision: omitted.setup.editableConnection!.revision,
  });
  expect(loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default.options)
    .not.toHaveProperty("prompt_cache_options");
  expect((await service().status()).existingModel).not.toHaveProperty("promptCache", true);
  expect(loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default.options)
    .toEqual({ custom: { retained: true } });
});

test("adding an OpenAI model persists its explicit choice without enabling the default model", async () => {
  const fixture = await createModelSetupFixture(artifactRoot);
  try {
    await fixture.service.add({
      profileId: "cached", model: "fixture-model", promptCache: true,
      newProvider: { id: "cloud", type: "openai" }, apiKey: "fixture-key",
    });
    expect((await fixture.readModelProfile("cached")).options.prompt_cache_options)
      .toEqual({ mode: "implicit" });
    expect((await fixture.readModelProfile("default")).options?.prompt_cache_options).toBeUndefined();
  } finally { await fixture.cleanup(); }
});

test("profile building preserves unrelated options and clears only the opt-in", () => {
  const template = { options: { custom: { keep: true }, prompt_cache_options: { mode: "implicit" } } };
  const original = structuredClone(template);
  expect(buildModelConfig(template, "openai", "fixture", undefined, { promptCache: false }).options)
    .toEqual({ custom: { keep: true } });
  expect(buildModelConfig(template, "openai", "fixture").options).toEqual(template.options);
  expect(buildModelConfig(template, "ollama", "fixture").options).toEqual({ custom: { keep: true } });
  expect(template).toEqual(original);
});

test.each(["ollama", "llamacpp", "openai-chatgpt"])("rejects opt-in for %s without changing default behavior", (provider) => {
  expect(() => buildModelConfig({}, provider, "fixture", undefined, { promptCache: true }))
    .toThrow(/OpenAI API/);
  expect(buildModelConfig({}, provider, "fixture").options).toBeUndefined();
});

test("CLI init and add-model persist explicit opt-in while omitted flags preserve provider defaults", async () => {
  const run = (script: string, args: string[]) => exec(process.execPath, [
    join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
    join(process.cwd(), "scripts", script), ...args, "--root", rootDir,
  ], { env: { ...process.env, LLM_RUNTIME_CONFIG_FILE: "" } });
  await run("init-runtime.ts", ["--provider", "openai", "--model", "fixture", "--prompt-cache", "true"]);
  const read = async (name: string) => JSON.parse(await readFile(join(rootDir, "local/models", name + ".config.json"), "utf8"));
  expect((await read("default")).options.prompt_cache_options).toEqual({ mode: "implicit" });
  await run("add-runtime-model.ts", ["--provider", "openai", "--model", "fixture2", "--profile", "ordinary"]);
  expect((await read("ordinary")).options?.prompt_cache_options).toBeUndefined();
  await run("add-runtime-model.ts", ["--provider", "openai", "--model", "fixture3", "--profile", "cached", "--prompt-cache=true"]);
  expect((await read("cached")).options.prompt_cache_options).toEqual({ mode: "implicit" });
});

test("the Models editor saves and reloads only the cache option on a linked alias profile", async () => {
  const fixture = await createModelSetupFixture(artifactRoot);
  try {
    await fixture.service.add({
      profileId: "editable", model: "fixture-model",
      newProvider: { id: "custom-cloud", type: "openai" }, apiKey: "fixture-key",
    });
    const options = { rootDir: fixture.rootDir, configPath: fixture.configPath };
    let snapshot = await getConfigDashboardSnapshot(options);
    let file = snapshot.files.models.find((entry) => entry.id === "editable")!;
    await saveConfigDashboardFile({ ...options, kind: "model", id: file.id,
      expectedRevision: file.revision, config: {
        ...file.config, options: { existing_option: 7, prompt_cache_options: { mode: "implicit" } },
      },
    });
    snapshot = await getConfigDashboardSnapshot(options);
    file = snapshot.files.models.find((entry) => entry.id === "editable")!;
    expect(file.config.options).toEqual({ existing_option: 7, prompt_cache_options: { mode: "implicit" } });
    await saveConfigDashboardFile({ ...options, kind: "model", id: file.id,
      expectedRevision: file.revision, config: { ...file.config, options: { existing_option: 7 } },
    });
    expect((await fixture.readModelProfile("editable")).options).toEqual({ existing_option: 7 });
  } finally { await fixture.cleanup(); }
});

test.each(["true", {}, null])("rejects malformed setup cache choice %j before saving configuration", async (promptCache) => {
  await expect(service().save({ ...connection, promptCache })).rejects.toThrow("must be true or false");
  expect(configPath).toBeUndefined();
});

test("model addition rejects a local provider opt-in before changing files", async () => {
  const fixture = await createModelSetupFixture(artifactRoot);
  try {
    const original = await fixture.readConfig();
    await expect(fixture.service.add({
      profileId: "invalid", model: "fixture", providerId: "ollama", promptCache: true,
    })).rejects.toThrow("OpenAI API");
    expect(await fixture.readConfig()).toEqual(original);
    await expect(readFile(join(fixture.rootDir, "local/models/invalid.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fixture.cleanup(); }
});
