import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../../web-ui/config-dashboard-backend.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { createModelSetupFixture, type ModelSetupFixture } from "./support/model-setup-fixture.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspaceMutations } from "../../web-ui/app/components/config-workspace/workspace-mutations.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspacePersistence } from "../../web-ui/app/components/config-workspace/workspace-persistence.js";

let fixture: ModelSetupFixture;
afterEach(async () => { await fixture?.cleanup(); });

test("real malformed linked files can be repaired from browser state through canonical saves back to ready", async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-save-repair-20260908/repair-ui",
  );
  const config = await fixture.readConfig();
  const modelId = Object.keys(config.models.profiles)[0]!;
  const root = dirname(fixture.configPath);
  const runnerPath = resolve(root, config.requestRunner.configRef);
  const modelPath = resolve(root, config.models.profiles[modelId].configRef);
  const originalRunner = await readFile(runnerPath, "utf8");
  const originalModel = await readFile(modelPath, "utf8");
  await writeFile(runnerPath, "{broken-runner");
  await writeFile(modelPath, "{broken-model");
  const setup = new RuntimeSetupService({
    rootDir: fixture.rootDir,
    getConfigPath: () => fixture.configPath,
    activate: async () => ({ status: "ready" }),
  });
  const registry = new RuntimeEnvironmentRegistry({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
  });
  expect(await setup.status()).toMatchObject({ status: "required", recovery: "configuration" });
  expect(registry.modelCatalog("prod").availability.status).toBe("setup_required");

  const model = createConfigWorkspaceModel();
  const editor = { value: "" };
  const dom = { configDashboard: { querySelector: () => editor } };
  const mutations = createConfigWorkspaceMutations({
    ...model, dom, confirmDiscard: vi.fn(() => true),
    recordControlEvent: vi.fn(), setWorkspaceStatus: vi.fn(),
    syncDirtyPresentation: () => {
      editor.value = model.rawDraftFor(model.selectedRawConfigFile());
    },
    renderConfigDashboard: () => {
      editor.value = model.rawDraftFor(model.selectedRawConfigFile());
    },
  });
  const saveFile = vi.fn((input: Parameters<typeof saveConfigDashboardFile>[0]) =>
    saveConfigDashboardFile({ ...input, rootDir: fixture.rootDir, configPath: fixture.configPath }),
  );
  const persistence = createConfigWorkspacePersistence({
    ...model, ...mutations, dom, saveFile,
    recordControlEvent: vi.fn(), setWorkspaceStatus: vi.fn(),
    syncDashboardInteractivity: vi.fn(), syncDirtyPresentation: vi.fn(),
  });
  mutations.replaceDashboard({ dashboard: await getConfigDashboardSnapshot(fixture) });
  expect(model.state.activeCategory).toBe("models");
  expect(model.state.rawPanelOpen).toBe(true);
  expect(editor.value).toBe("{broken-runner");
  expect(model.hasUnsavedChanges()).toBe(false);

  editor.value = originalRunner;
  model.state.rawDraftsByKey.set(model.state.selectedRawConfigKey, originalRunner);
  await persistence.saveRawDraft();
  expect(saveFile).toHaveBeenCalledOnce();
  expect(model.hasUnsavedChanges()).toBe(false);
  expect(await readFile(modelPath, "utf8")).toBe("{broken-model");
  expect(await setup.status()).toMatchObject({ status: "required", recovery: "configuration" });
  expect(model.findConfigFile("model", modelId).invalidJson.raw).toBe("{broken-model");

  mutations.changeRawFile(`model:${modelId}`, { value: "" });
  expect(editor.value).toBe("{broken-model");
  editor.value = originalModel;
  model.state.rawDraftsByKey.set(model.state.selectedRawConfigKey, originalModel);
  await persistence.saveRawDraft();
  expect(saveFile).toHaveBeenCalledTimes(2);
  expect(model.hasUnsavedChanges()).toBe(false);
  const saved = await getConfigDashboardSnapshot(fixture);
  expect(saved.files.requestRunner).not.toHaveProperty("invalidJson");
  expect(saved.files.models[0]).not.toHaveProperty("invalidJson");
  expect(JSON.parse(await readFile(runnerPath, "utf8"))).toEqual(JSON.parse(originalRunner));
  expect(JSON.parse(await readFile(modelPath, "utf8"))).toEqual(JSON.parse(originalModel));
  expect(await setup.status()).toMatchObject({ status: "ready" });
  expect(registry.modelCatalog("prod").availability.status).toBe("ready");
});
