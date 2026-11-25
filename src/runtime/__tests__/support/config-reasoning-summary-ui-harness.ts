import { tmpdir } from "node:os";
import { realpath } from "node:fs/promises";
import { vi } from "vitest";
import { getConfigDashboardSnapshot, saveConfigDashboardFile } from "../../../web-ui/config-dashboard-backend.js";
import { createModelSetupFixture } from "./model-setup-fixture.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspaceModel } from "../../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspaceEvents } from "../../../web-ui/app/components/config-workspace/workspace-events.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspaceMutations } from "../../../web-ui/app/components/config-workspace/workspace-mutations.js";
// @ts-expect-error Browser-only module.
import { createConfigWorkspacePersistence } from "../../../web-ui/app/components/config-workspace/workspace-persistence.js";
// @ts-expect-error Browser-only module.
import { createConfigFieldRendering } from "../../../web-ui/app/components/config-workspace/field-rendering.js";
// @ts-expect-error Browser-only module.
import { createConfigModelRendering } from "../../../web-ui/app/components/config-workspace/model-rendering.js";

export async function createReasoningSummaryUiHarness(seed: Record<string, unknown> = {}) {
  const fixture = await createModelSetupFixture(await realpath(tmpdir()));
  try {
    return await bindReasoningSummaryWorkspace(fixture, seed);
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

async function bindReasoningSummaryWorkspace(
  fixture: Awaited<ReturnType<typeof createModelSetupFixture>>,
  seed: Record<string, unknown>,
) {
  const runtime = await fixture.readConfig();
  const id = Object.keys(runtime.models.profiles)[0]!;
  runtime.models.providers = {
    ...runtime.models.providers,
    cloudApi: { type: "openai", apiKeyEnv: "MODEL_FIXTURE_KEY" },
    signedIn: { type: "openai-chatgpt" },
    localNative: { type: "llamacpp" },
    openai: { type: "ollama" },
  };
  await fixture.writeConfig(runtime);
  await fixture.writeModelProfile(id, {
    ...await fixture.readModelProfile(id),
    provider: "cloudApi", model: "gpt-5", supportsThinking: true,
    generation: { reasoningEffort: "medium" },
    options: { preservedOption: "keep" },
    calibration: { response: { generation: { temperature: 0.5 } } },
    ...seed,
  });
  const model = createConfigWorkspaceModel();
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const root = {
    addEventListener: (type: string, callback: (event: unknown) => void) =>
      listeners.set(type, [...(listeners.get(type) || []), callback]),
    querySelector: () => null,
    querySelectorAll: () => [],
    innerHTML: "",
  };
  const dom = { configDashboard: root, configStatus: { textContent: "" },
    refreshConfigButton: { addEventListener: () => undefined } };
  const fields = createConfigFieldRendering({ ...model });
  const rendering = createConfigModelRendering({ ...model, ...fields });
  const render = () => rendering.renderSelectedModelEditor(model.state.configDashboard?.files.models || []) as string;
  const renderConfigDashboard = vi.fn(render);
  const syncDirtyPresentation = vi.fn();
  const setWorkspaceStatus = vi.fn();
  const recordControlEvent = vi.fn();
  const mutations = createConfigWorkspaceMutations({ ...model, dom,
    confirmDiscard: vi.fn(() => true), renderConfigDashboard, syncDirtyPresentation,
    setWorkspaceStatus, recordControlEvent });
  const saveFile = vi.fn((input: Parameters<typeof saveConfigDashboardFile>[0]) =>
    saveConfigDashboardFile({ ...input, rootDir: fixture.rootDir, configPath: fixture.configPath }));
  const loadDashboard = async () => ({ dashboard: await getConfigDashboardSnapshot(fixture) });
  const persistence = createConfigWorkspacePersistence({ ...model, ...mutations, dom,
    saveFile, loadDashboard, recordControlEvent, setWorkspaceStatus,
    syncDashboardInteractivity: vi.fn(), syncDirtyPresentation,
    memorySetup: { load: async () => {} }, memoryManagement: { load: async () => {} },
  });
  let pendingSave: Promise<unknown> | undefined;
  createConfigWorkspaceEvents({ ...model, ...mutations, ...persistence, dom, eventTarget: {},
    renderConfigDashboard, syncDirtyPresentation, setWorkspaceStatus,
    saveConfigFile: (kind: string, fileId: string) => {
      pendingSave = persistence.saveConfigFile(kind, fileId);
      return pendingSave;
    },
  }).bind();
  mutations.replaceDashboard(await loadDashboard());

  function dispatch(type: string, dataset: Record<string, string>, value = "") {
    const element = { dataset: { kind: "model", id, ...dataset }, value,
      matches: () => true, closest: () => element };
    for (const listener of listeners.get(type) || []) listener({ target: element });
  }
  function field(path: string[], value: string, valueType = "select") {
    dispatch("change", { configAction: "field", path: JSON.stringify(path), valueType }, value);
  }
  return {
    fixture, id, model, render, saveFile, renderConfigDashboard, syncDirtyPresentation,
    file: () => model.findConfigFile("model", id),
    field,
    select: (value: string) => field(["options", "reasoningSummary"], value, "reasoning-summary"),
    reset: () => dispatch("click", { configAction: "reset-file" }),
    save: async () => { dispatch("click", { configAction: "save-file" }); await pendingSave; },
    reload: () => persistence.loadRuntimeConfig({ protectUnsaved: false }),
    readSaved: () => fixture.readModelProfile(id),
    cleanup: fixture.cleanup,
  };
}

export type ReasoningSummaryUiHarness = Awaited<ReturnType<typeof createReasoningSummaryUiHarness>>;
