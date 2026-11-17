import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readRuntimeSetupDraft, writeRuntimeSetupDraft } from "../../web-ui/local-runtime/runtime-setup-draft.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { createModelSetupFixture, type ModelSetupFixture } from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(".codex/artifacts/local-profile-temperature/gui");
});
afterEach(async () => { await fixture.cleanup(); });

test.each(["registered", "orphan"])(
  "%s legacy GUI additions retain their exact file even when recovered after upgrading",
  async status => {
    const input = { profileId: "worker", providerId: "ollama", model: "test-model" };
    const result = await fixture.service.add(input);
    const profile = await fixture.readModelProfile(input.profileId);
    expect(profile.generation).toBeUndefined();
    // Reproduce the historical file shape; retries must preserve it byte-for-byte.
    profile.calibration["context.compact"].generation = { temperature: 0, reasoningEffort: "none" };
    await fixture.writeModelProfile(input.profileId, profile);
    const config = await fixture.readConfig();
    const path = resolve(dirname(fixture.configPath), config.models.profiles.worker.configRef);
    if (status === "orphan") {
      delete config.models.profiles.worker;
      await fixture.writeConfig(config);
    }
    const original = await readFile(path, "utf8");
    const originalConfig = await readFile(fixture.configPath, "utf8");
    await expect(fixture.service.add(input)).resolves.toEqual(result);
    expect(await readFile(path, "utf8")).toBe(original);
    if (status === "registered") expect(await readFile(fixture.configPath, "utf8")).toBe(originalConfig);
  },
);

test.each(["registered", "orphan"])("rejects a %s model whose temperature was explicitly changed", async status => {
  const input = { profileId: "local", newProvider: { type: "llamacpp", id: "local-llama" }, model: "test-model" };
  await fixture.service.add(input);
  const profile = await fixture.readModelProfile(input.profileId);
  expect(profile.generation).toBeUndefined();
  profile.generation = { temperature: 0.7 };
  await fixture.writeModelProfile(input.profileId, profile);
  const config = await fixture.readConfig();
  const path = resolve(dirname(fixture.configPath), config.models.profiles.local.configRef);
  if (status === "orphan") {
    delete config.models.profiles.local;
    await fixture.writeConfig(config);
  }
  const original = await readFile(path, "utf8");
  await expect(fixture.service.add({ profileId: input.profileId, providerId: "local-llama", model: input.model }))
    .rejects.toMatchObject({ code: "model_profile_exists" });
  expect(await readFile(path, "utf8")).toBe(original);
});

test.each([
  { temperature: undefined, native: undefined },
  { temperature: 0, native: undefined },
  { temperature: 0.65, native: undefined },
  { temperature: undefined, native: 0.8 },
])("a same-model connection edit retains saved sampling $temperature / $native", async ({ temperature, native }) => {
  const draft = (await readRuntimeSetupDraft(fixture.configPath))!;
  const modelConfig = await fixture.readModelProfile("default");
  expect(modelConfig.generation).toBeUndefined();
  if (temperature === undefined) delete modelConfig.generation;
  else modelConfig.generation = { temperature };
  if (native !== undefined) modelConfig.options = { temperature: native };
  await fixture.writeModelProfile("default", modelConfig);
  await writeRuntimeSetupDraft({ ...draft, modelConfig });
  const wizard = new RuntimeSetupService({
    rootDir: fixture.rootDir, getConfigPath: () => fixture.configPath,
    activate: async () => { throw new Error("a deferred connection edit must not activate the runtime"); },
  });
  const edit = await wizard.save({
    provider: "ollama", model: "fixture-chat", baseUrl: "http://127.0.0.1:4999", deferActivation: true,
    connectionRevision: draft.revision,
  });
  const saved = await fixture.readModelProfile("default");
  expect(saved.generation).toEqual(modelConfig.generation);
  expect(saved.options?.temperature).toBe(native);
  await wizard.save({
    provider: "llamacpp", model: "replacement", deferActivation: true, connectionRevision: edit.setup.editableConnection!.revision,
  });
  const replacement = await fixture.readModelProfile("default");
  expect(replacement.generation).toBeUndefined();
  expect(replacement.options?.temperature).toBeUndefined();
});

test("same-model connection edits preserve generic controls including explicit omission", async () => {
  const draft = (await readRuntimeSetupDraft(fixture.configPath))!;
  const modelConfig = await fixture.readModelProfile("default");
  modelConfig.generation = { parameters: {
    temperature: { mode: "inherit" }, top_k: { mode: "value", value: 0 },
    max_output_tokens: { mode: "omit" },
  } };
  await fixture.writeModelProfile("default", modelConfig);
  await writeRuntimeSetupDraft({ ...draft, modelConfig });
  const wizard = new RuntimeSetupService({
    rootDir: fixture.rootDir, getConfigPath: () => fixture.configPath,
    activate: async () => { throw new Error("connection edits must remain deferred"); },
  });
  await wizard.save({ provider: "ollama", model: "fixture-chat",
    baseUrl: "http://127.0.0.1:4999", deferActivation: true, connectionRevision: draft.revision });
  expect((await fixture.readModelProfile("default")).generation).toEqual(modelConfig.generation);
});
