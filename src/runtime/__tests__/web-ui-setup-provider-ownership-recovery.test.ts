import * as setupDraft from "../../web-ui/local-runtime/runtime-setup-draft.js";
import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let service: RuntimeSetupService;
const activate = vi.fn(async () => ({ status: "ready" as const }));
const localConnection = {
  provider: "ollama",
  model: "recovered-chat",
  deferActivation: true,
  baseUrl: "http://127.0.0.1:11434",
};
const cloudConnection = {
  provider: "openai",
  model: "recovered-cloud",
  deferActivation: true,
  apiKey: "fixture-recovered-provider-key",
};
const receipt = () => readFile(fixture.configPath + ".web-setup.json", "utf8");
const originalModel = () =>
  join(dirname(fixture.configPath), "models/default.config.json");

beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-recovery-guards-20260908/provider-ownership",
  );
  activate.mockClear();
  service = new RuntimeSetupService({
    rootDir: fixture.rootDir,
    getConfigPath: () => fixture.configPath,
    activate,
  });
});
afterEach(async () => fixture.cleanup());

async function removeProfiles() {
  const config = await fixture.readConfig();
  config.models.profiles = {};
  await fixture.writeConfig(config);
  return config;
}

test("recovers ownership of an unchanged provider so its address can be corrected and edited again", async () => {
  await removeProfiles();
  const beforeModel = await readFile(originalModel(), "utf8");
  const recovered = await service.save({
    ...localConnection,
    baseUrl: "http://corrected.example:11434",
  });
  const config = await fixture.readConfig();
  expect(config.models.providers.ollama.baseUrl).toBe(
    "http://corrected.example:11434",
  );
  expect(JSON.parse(await receipt()).ownedProviders).toEqual({
    ollama: config.models.providers.ollama,
  });
  expect(await readFile(originalModel(), "utf8")).toBe(beforeModel);
  const edited = await service.save({
    ...localConnection,
    baseUrl: "http://edited-again.example:11434",
    connectionRevision: recovered.setup.editableConnection!.revision,
  });
  expect((await fixture.readConfig()).models.providers.ollama.baseUrl).toBe(
    "http://edited-again.example:11434",
  );
  expect(edited.setup.editableConnection!.revision).not.toBe(
    recovered.setup.editableConnection!.revision,
  );
  expect(activate).not.toHaveBeenCalled();
});

test("recovery prunes an unused owned provider and keeps new ownership for a later switch", async () => {
  await removeProfiles();
  const beforeModel = await readFile(originalModel(), "utf8");
  const recovered = await service.save(cloudConnection);
  expect(Object.keys((await fixture.readConfig()).models.providers)).toEqual([
    "openai",
  ]);
  expect(Object.keys(JSON.parse(await receipt()).ownedProviders)).toEqual([
    "openai",
  ]);
  await service.save({
    ...localConnection,
    connectionRevision: recovered.setup.editableConnection!.revision,
  });
  expect(Object.keys((await fixture.readConfig()).models.providers)).toEqual([
    "ollama",
  ]);
  expect(await readFile(originalModel(), "utf8")).toBe(beforeModel);
  expect(await fixture.readEnv()).toContain(cloudConnection.apiKey);
});

test("an externally changed provider is neither replaced nor reclaimed during recovery", async () => {
  const config = await removeProfiles();
  config.models.providers.ollama.baseUrl =
    "http://external-owner.example:11434";
  await fixture.writeConfig(config);
  const beforeConfig = await readFile(fixture.configPath, "utf8");
  const beforeReceipt = await receipt();
  const beforeEnv = await fixture.readEnv();
  await expect(service.save(localConnection)).rejects.toMatchObject({
    code: "setup_provider_conflict",
  });
  expect(await readFile(fixture.configPath, "utf8")).toBe(beforeConfig);
  expect(await receipt()).toBe(beforeReceipt);
  expect(await fixture.readEnv()).toBe(beforeEnv);
  await service.save(cloudConnection);
  expect((await fixture.readConfig()).models.providers.ollama).toEqual(
    config.models.providers.ollama,
  );
  expect(Object.keys(JSON.parse(await receipt()).ownedProviders)).toEqual([
    "openai",
  ]);
});

test.each([true, false])(
  "keeps embedding-referenced owned providers and unrelated providers when memory enabled is %s",
  async (enabled) => {
    const config = await removeProfiles();
    config.models.providers.unrelated = {
      type: "ollama",
      baseUrl: "http://unrelated.example:11434",
    };
    config.models.embeddingProfiles = {
      archived: { provider: " ollama ", model: "retained-embedding" },
    };
    config.longTermMemory = { enabled, embeddingProfileId: "archived" };
    await fixture.writeConfig(config);
    await service.save(cloudConnection);
    const after = await fixture.readConfig();
    expect(after.models.providers.ollama).toEqual(
      config.models.providers.ollama,
    );
    expect(after.models.providers.unrelated).toEqual(
      config.models.providers.unrelated,
    );
    expect(after.models.embeddingProfiles).toEqual(
      config.models.embeddingProfiles,
    );
    expect(after.longTermMemory).toEqual(config.longTermMemory);
    expect(JSON.parse(await receipt()).ownedProviders).toEqual({
      ollama: config.models.providers.ollama,
      openai: after.models.providers.openai,
    });
  },
);

test.each([true, false])(
  "a recovered provider address change invalidates only enabled selected embeddings (enabled %s)",
  async (enabled) => {
    const config = await removeProfiles();
    config.models.embeddingProfiles = {
      selected: { provider: " ollama ", model: "retained-embedding" },
    };
    config.longTermMemory = {
      enabled,
      embeddingProfileId: " selected ",
    };
    await fixture.writeConfig(config);
    const saved = await service.save({
      ...localConnection,
      baseUrl: "http://corrected.example:11434",
    });
    const after = await fixture.readConfig();
    expect(saved.embeddingInvalidated).toBe(enabled);
    expect(after.longTermMemory).toEqual({
      ...config.longTermMemory,
      enabled: false,
    });
    expect(after.models.embeddingProfiles).toEqual(
      config.models.embeddingProfiles,
    );
    expect(JSON.parse(await receipt()).ownedProviders).toEqual({
      ollama: after.models.providers.ollama,
    });
  },
);

test("a receipt bound to another config path cannot reclaim a matching provider", async () => {
  await removeProfiles();
  const draft = JSON.parse(await receipt());
  draft.configPath = join(fixture.rootDir, "different.config.json");
  await writeFile(
    fixture.configPath + ".web-setup.json",
    JSON.stringify(draft),
  );
  const before = await fixture.readConfig();
  await expect(
    service.save({ ...localConnection, baseUrl: "http://new.example:11434" }),
  ).rejects.toMatchObject({ code: "setup_provider_conflict" });
  expect(await fixture.readConfig()).toEqual(before);
  await service.save(cloudConnection);
  expect((await fixture.readConfig()).models.providers.ollama).toEqual(
    before.models.providers.ollama,
  );
  expect(Object.keys(JSON.parse(await receipt()).ownedProviders)).toEqual([
    "openai",
  ]);
});

test("canonical aliases of the same config retain recoverable provider ownership", async () => {
  await removeProfiles();
  const aliasPath = join(
    dirname(fixture.configPath),
    "runtime-alias.config.json",
  );
  await symlink(fixture.configPath, aliasPath);
  const aliasService = new RuntimeSetupService({
    rootDir: fixture.rootDir,
    getConfigPath: () => aliasPath,
    activate,
  });
  await aliasService.save({
    ...localConnection,
    baseUrl: "http://alias-correction.example:11434",
  });
  expect((await fixture.readConfig()).models.providers.ollama.baseUrl).toBe(
    "http://alias-correction.example:11434",
  );
  expect(Object.keys(JSON.parse(await receipt()).ownedProviders)).toEqual([
    "ollama",
  ]);
});

test("failed recovered ownership receipt creation restores the old configuration, receipt and orphan before retry", async () => {
  const before = await removeProfiles();
  const beforeReceipt = await receipt();
  const beforeModel = await readFile(originalModel(), "utf8");
  const beforeFiles = (await readdir(dirname(originalModel()))).sort();
  vi.spyOn(setupDraft, "createRuntimeSetupDraft").mockRejectedValueOnce(
    new Error("fixture-recovered-ownership-failed"),
  );
  await expect(service.save(cloudConnection)).rejects.toThrow(
    "fixture-recovered-ownership-failed",
  );
  expect(await fixture.readConfig()).toEqual(before);
  expect(await receipt()).toBe(beforeReceipt);
  expect(await readFile(originalModel(), "utf8")).toBe(beforeModel);
  expect((await readdir(dirname(originalModel()))).sort()).toEqual(beforeFiles);
  await service.save(cloudConnection);
  expect(Object.keys((await fixture.readConfig()).models.providers)).toEqual([
    "openai",
  ]);
  expect(await readFile(originalModel(), "utf8")).toBe(beforeModel);
});
