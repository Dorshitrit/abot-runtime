import { expect, test, vi } from "vitest";
import { createModelWizardHarness } from "./support/model-setup-wizard-harness.js";
import { createGuideHarness, setupSnapshot } from "./support/runtime-setup-guide-harness.js";
// @ts-expect-error Browser workspace module has no declaration surface.
import { createConfigWorkspaceEvents } from "../../web-ui/app/components/config-workspace/workspace-events.js";
// @ts-expect-error Browser workspace model has no declaration surface.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { renderModelPromptCache } from "../../web-ui/app/components/config-workspace/prompt-cache.js";

test("onboarding submits an explicit choice", async () => {
  const harness = createGuideHarness();
  await harness.open();
  harness.changeProvider("openai");
  harness.submit();
  expect(harness.container.innerHTML).toContain('data-runtime-setup-field="prompt-cache"');
  harness.inputModel("fixture");
  harness.inputKey("fixture-key");
  harness.inputPromptCache(true);
  harness.submit();
  await harness.ready();
  expect(harness.submissions[0]).toMatchObject({ promptCache: true, provider: "openai" });
});

test("onboarding reloads the saved opt-in and submits an explicit disable", async () => {
  const harness = createGuideHarness({
    loadSetup: async () => ({ setup: {
      ...setupSnapshot, status: "ready", configExists: true,
      editableConnection: { revision: "fixture-revision" },
      existingModel: { provider: "openai", model: "fixture", contextWindowTokens: 32768, promptCache: true },
      providers: setupSnapshot.providers.map((provider) => ({ ...provider, credentialConfigured: true })),
    } }),
  });
  await harness.open();
  expect(harness.container.innerHTML).toMatch(/data-runtime-setup-field="prompt-cache" checked/);
  harness.inputPromptCache(false);
  harness.submit();
  await harness.ready();
  expect(harness.submissions[0]).toMatchObject({ promptCache: false });
});

test("Add Model uses the selected provider type, carries the choice through review, and resets it", async () => {
  const harness = createModelWizardHarness();
  await harness.wizard.open({ providerId: "cloud" });
  const checkbox = harness.field("prompt-cache")!;
  expect(checkbox).toBeTruthy();
  Object.assign(checkbox, { checked: true }); checkbox.dispatch("input");
  harness.input("model-id", "cache-model");
  harness.click("next");
  harness.click("finish");
  await harness.settled();
  expect(harness.requests[0]).toMatchObject({ providerId: "cloud", promptCache: true });
  harness.wizard.close();
  await harness.wizard.open({ providerId: "local" });
  expect(harness.field("prompt-cache")).toBeNull();
  harness.input("model-id", "local-model");
  harness.click("next"); harness.click("finish");
  await harness.settled();
  expect(harness.requests[1]).not.toHaveProperty("promptCache");
});

test("Models editor resolves provider aliases and mutates only its cache option", () => {
  const file = { kind: "model", id: "profile", config: {
    provider: "cloud-alias", options: { unrelated: { keep: true } } as Record<string, unknown>,
  } };
  const dashboard = { files: { runtime: { config: { models: {
    providers: { "cloud-alias": { type: "openai" }, local: { type: "ollama" }, account: { type: "openai-chatgpt" } },
  } } } } };
  const model = createConfigWorkspaceModel();
  model.state.configDashboard = dashboard;
  const listeners = new Map<string, (event: unknown) => void>();
  const renderConfigDashboard = vi.fn();
  const events = createConfigWorkspaceEvents({
    ...model, state: model.state, eventTarget: {},
    dom: {
      configDashboard: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) },
      refreshConfigButton: { addEventListener: () => undefined },
    },
    dashboardIsBusy: () => false, findConfigFile: () => file,
    mutateConfigFile: (_kind: string, _id: string, mutate: (config: typeof file.config) => void) => mutate(file.config),
    renderConfigDashboard,
  });
  events.bind();
  const change = (path: string[], valueType: string, value: string | boolean) => {
    const element = {
      dataset: { configAction: "field", kind: "model", id: file.id, path: JSON.stringify(path), valueType },
      value, checked: value === true, matches: () => true, closest: () => element,
    };
    listeners.get("change")!({ target: element });
  };
  expect(renderModelPromptCache(file, dashboard)).toContain('data-value-type="prompt-cache"');
  change(["options", "prompt_cache_options"], "prompt-cache", true);
  expect(file.config.options).toEqual({ unrelated: { keep: true }, prompt_cache_options: { mode: "implicit" } });
  expect(renderModelPromptCache(file, dashboard)).toMatch(/data-value-type="prompt-cache" checked/);
  change(["options", "prompt_cache_options"], "prompt-cache", false);
  expect(file.config.options).toEqual({ unrelated: { keep: true } });
  change(["options", "prompt_cache_options"], "prompt-cache", true);
  change(["provider"], "string", "local");
  expect(file.config.options).toEqual({ unrelated: { keep: true } });
  expect(renderModelPromptCache(file, dashboard)).toBe("");
  change(["provider"], "string", "account");
  expect(renderModelPromptCache(file, dashboard)).toBe("");
  change(["provider"], "string", "cloud-alias");
  expect(file.config.options).not.toHaveProperty("prompt_cache_options");
});

test("changing onboarding provider clears the previous opt-in before saving", async () => {
  const harness = createGuideHarness();
  await harness.open();
  harness.changeProvider("openai"); harness.submit();
  harness.inputPromptCache(true);
  harness.click("back");
  harness.changeProvider("ollama"); harness.submit();
  expect(harness.container.innerHTML).not.toContain('data-runtime-setup-field="prompt-cache"');
  harness.inputModel("local-fixture"); harness.submit();
  await harness.ready();
  expect(harness.submissions[0]).not.toHaveProperty("promptCache");
});
