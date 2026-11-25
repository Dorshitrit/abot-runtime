import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as setupFiles from "../../../scripts/runtime-setup-files.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { readSetupReasoningSummary } from "../../model-gateway/providers/openai/setup-reasoning-summary.js";
import { loadRuntimeConfig } from "../config.js";
import { createModelSetupFixture } from "./support/model-setup-fixture.js";

let rootDir = "";
let configPath: string | undefined;
const activate = vi.fn(async () => ({ status: "ready" as const }));
const connection = { provider: "openai", model: "fixture-model", apiKey: "fixture-key", deferActivation: true };
const service = () => new RuntimeSetupService({
  rootDir, getConfigPath: () => configPath,
  configure: (path) => { configPath = path; }, activate,
});
const profileOptions = () => loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default.options;

async function fileSnapshot(path: string) {
  const metadata = await stat(path, { bigint: true });
  return { bytes: await readFile(path, "utf8"), modified: metadata.mtimeNs };
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(await realpath(tmpdir()), "abot-summary-setup-"));
  configPath = undefined;
  activate.mockClear();
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

describe("Web setup reasoning summaries", () => {
  test.each(["auto", "concise", "detailed", null])("saves and hydrates %s without activating or rewriting on reload", async (reasoningSummary) => {
    const result = await service().save({ ...connection, reasoningSummary });
    expect(profileOptions()).toMatchObject({ reasoningSummary });
    expect(result.setup.existingModel).toMatchObject({ reasoningSummary });
    const path = join(dirname(configPath!), "models/default.config.json");
    const before = await fileSnapshot(path);
    expect((await service().status()).existingModel).toMatchObject({ reasoningSummary });
    expect(await fileSnapshot(path)).toEqual(before);
    expect(activate).not.toHaveBeenCalled();
  });

  test("revisioned editing preserves omitted and unrelated options, then persists explicit Off", async () => {
    const readTemplate = setupFiles.readJsonObject;
    const template = vi.spyOn(setupFiles, "readJsonObject").mockImplementation(async (path) => {
      const value = await readTemplate(path);
      return path.endsWith("examples/models/default.config.json")
        ? { ...value, options: { custom: { retained: true } } } : value;
    });
    const first = await service().save({ ...connection, reasoningSummary: "auto" });
    template.mockRestore();
    const credentialBefore = await readFile(join(rootDir, ".env"), "utf8");
    const omitted = await service().save({
      ...connection, model: "edited-model", connectionRevision: first.setup.editableConnection!.revision,
    });
    expect(profileOptions()).toEqual({ custom: { retained: true }, reasoningSummary: "auto" });
    await service().save({
      ...connection, model: "edited-model", reasoningSummary: null,
      connectionRevision: omitted.setup.editableConnection!.revision,
    });
    expect(profileOptions()).toEqual({ custom: { retained: true }, reasoningSummary: null });
    expect((await service().status()).existingModel).toMatchObject({ reasoningSummary: null });
    expect(await readFile(join(rootDir, ".env"), "utf8")).toBe(credentialBefore);
  });

  test("keeps a dormant choice on an omitted provider change and restores it on return", async () => {
    const first = await service().save({ ...connection, reasoningSummary: "detailed" });
    const local = await service().save({
      provider: "ollama", model: "fixture-local", deferActivation: true,
      connectionRevision: first.setup.editableConnection!.revision,
    });
    expect(profileOptions()).toMatchObject({ reasoningSummary: "detailed" });
    expect(local.setup.existingModel).not.toHaveProperty("reasoningSummary");
    await service().save({ ...connection, connectionRevision: local.setup.editableConnection!.revision });
    expect(profileOptions()).toMatchObject({ reasoningSummary: "detailed" });
    expect((await service().status()).existingModel).toMatchObject({ reasoningSummary: "detailed" });
  });

  test.each(["", "AUTO", "off", true, false, 1, [], {}].map((value) => ({ value })))(
    "rejects invalid choice $value before creating configuration or credentials", async ({ value }) => {
      await expect(service().save({ ...connection, reasoningSummary: value })).rejects.toMatchObject({
        code: "invalid_setup_reasoning", statusCode: 400,
      });
      expect(configPath).toBeUndefined();
      expect(await readdir(rootDir)).toEqual([]);
    },
  );

  test.each(["ollama", "llamacpp", "openai-chatgpt"])("rejects enabled summaries for %s before side effects", async (provider) => {
    await expect(service().save({ provider, model: "fixture", reasoningSummary: "auto" }))
      .rejects.toMatchObject({ code: "invalid_setup_reasoning_summary", statusCode: 400 });
    expect(configPath).toBeUndefined();
    expect(await readdir(rootDir)).toEqual([]);
  });

  test.each(["ollama", "llamacpp", "openai-chatgpt"])("omitted or null summaries leave %s options unchanged", (provider) => {
    const template = { options: { custom: 7, reasoningSummary: "detailed" } };
    const baseline = setupFiles.buildModelConfig(template, provider, "fixture");
    expect(baseline.options).toEqual(template.options);
    expect(setupFiles.buildModelConfig(template, provider, "fixture", undefined, { reasoningSummary: null }))
      .toEqual(baseline);
    expect(readSetupReasoningSummary(provider, template.options)).toBeUndefined();
  });

  test("does not reinterpret an unknown saved choice during hydration or omitted editing", () => {
    const template = { options: { custom: 7, reasoningSummary: "future-value" } };
    expect(setupFiles.buildModelConfig(template, "openai", "fixture").options).toEqual(template.options);
    expect(readSetupReasoningSummary("openai", template.options)).toBeUndefined();
  });

  test("credential-only completion cannot change summary and preserves it when omitted", async () => {
    await service().save({ ...connection, reasoningSummary: "auto" });
    vi.stubEnv("OPENAI_API_KEY", "");
    await writeFile(join(rootDir, ".env"), "LLM_RUNTIME_CONFIG_FILE=" + configPath + "\n");
    const path = join(dirname(configPath!), "models/default.config.json");
    const modelBefore = await fileSnapshot(path);
    const credentialsBefore = await fileSnapshot(join(rootDir, ".env"));
    await expect(service().save({ ...connection, reasoningSummary: null }))
      .rejects.toMatchObject({ code: "setup_configuration_changed", statusCode: 409 });
    expect(await fileSnapshot(path)).toEqual(modelBefore);
    expect(await fileSnapshot(join(rootDir, ".env"))).toEqual(credentialsBefore);
    const result = await service().save({ ...connection, apiKey: "fixture-restored-key" });
    expect(result.setup.existingModel).toMatchObject({ reasoningSummary: "auto" });
    expect(await fileSnapshot(path)).toEqual(modelBefore);
  });
});

describe("Add Model reasoning summaries", () => {
  test.each(["auto", "concise", "detailed", null])("persists %s and acknowledges exact retry without rewriting", async (reasoningSummary) => {
    const fixture = await createModelSetupFixture(rootDir);
    try {
      const input = {
        profileId: "summary", model: "fixture", reasoningSummary,
        newProvider: { id: "cloud", type: "openai" }, apiKey: "fixture-key",
      };
      await fixture.service.add(input);
      expect((await fixture.readModelProfile("summary")).options).toMatchObject({ reasoningSummary });
      expect((await fixture.readModelProfile("default")).options?.reasoningSummary).toBeUndefined();
      const paths = [fixture.configPath, fixture.envPath, join(dirname(fixture.configPath), "models/summary.config.json")];
      const before = await Promise.all(paths.map(fileSnapshot));
      await expect(fixture.service.add(input)).resolves.toMatchObject({ model: { profileId: "summary" } });
      expect(await Promise.all(paths.map(fileSnapshot))).toEqual(before);
      const conflicting = reasoningSummary === "auto" ? "detailed" : "auto";
      await expect(fixture.service.add({ ...input, reasoningSummary: conflicting }))
        .rejects.toMatchObject({ code: "model_profile_exists", statusCode: 409 });
      await expect(fixture.service.add({ ...input, reasoningSummary: undefined }))
        .rejects.toMatchObject({ code: "model_profile_exists", statusCode: 409 });
      expect(await Promise.all(paths.map(fileSnapshot))).toEqual(before);
    } finally { await fixture.cleanup(); }
  });

  test("rejects invalid values and resolved local providers without saving profiles or credentials", async () => {
    const fixture = await createModelSetupFixture(rootDir);
    try {
      const before = await Promise.all([fixture.configPath, fixture.envPath].map(fileSnapshot));
      await expect(fixture.service.add({ profileId: "invalid", model: "fixture", providerId: "ollama", reasoningSummary: false }))
        .rejects.toMatchObject({ code: "invalid_model_reasoning", statusCode: 400 });
      await expect(fixture.service.add({ profileId: "invalid", model: "fixture", providerId: "ollama", reasoningSummary: "auto" }))
        .rejects.toMatchObject({ code: "invalid_model_reasoning_summary", statusCode: 400 });
      await expect(fixture.service.add({
        profileId: "invalid", model: "fixture", reasoningSummary: "auto", apiKey: "fixture-unused-key",
        newProvider: { id: "local", type: "llamacpp" },
      })).rejects.toMatchObject({ code: "invalid_model_reasoning_summary", statusCode: 400 });
      expect(await Promise.all([fixture.configPath, fixture.envPath].map(fileSnapshot))).toEqual(before);
      await expect(readFile(join(dirname(fixture.configPath), "models/invalid.config.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fixture.cleanup(); }
  });
});
