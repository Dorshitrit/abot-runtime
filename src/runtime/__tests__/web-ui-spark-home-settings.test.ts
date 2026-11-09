import { expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser controller.
import { createSparkHomeSettingsController } from "../../web-ui/app/controllers/spark-home-settings-controller.js";
// @ts-expect-error Browser view.
import { createSparkHomeSettingsView } from "../../web-ui/app/components/spark-home/settings-view.js";
// @ts-expect-error Browser workspace.
import { learningWorkspaceMarkup, navigateLearningTabs, selectLearningView } from "../../web-ui/app/components/passive-learning/workspace-view.js";

const initial = () => ({ revision: 0, personalInstructions: "", modelProfileId: null as string | null,
  effectiveModelProfileId: null, models: [{ id: "home-model", label: "Home model", provider: "", providerId: "" }], available: false,
  reason: "spark_home_model_required", schedulingAvailable: false });
async function fixture() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html"); document.body = document.createElement("body");
  const root = document.createElement("section"); root.innerHTML = learningWorkspaceMarkup("UTC");
  selectLearningView(root, "home");
  let environment = "dev"; let saved = initial();
  const client = {
    getSparkHomeSettings: vi.fn(async (_environment: string) => ({ settings: structuredClone(saved) })),
    listModels: vi.fn(),
    configureSparkHomeSettings: vi.fn(async (input: any, _environment: string) => {
      saved = { ...saved, ...input, revision: input.expectedRevision + 1 }; return { settings: structuredClone(saved) };
    }),
  };
  let controller: any;
  const view = createSparkHomeSettingsView({ root, onChange: (name: string, value: unknown) => controller.change(name, value),
    onSave: () => controller.save(), onReload: () => controller.reload() });
  controller = createSparkHomeSettingsController({ client, getEnvironmentId: () => environment, canUseSettings: () => true,
    render: view.render, focus: view.focus });
  await controller.setActive(true);
  const field = (name: string) => root.querySelector(`[data-home-setting="${name}"]`)!;
  const change = (name: string, value: string) => { const input = field(name); input.value = value; input.dispatch("input"); };
  return { root, document, client, controller, field, change, saved: () => saved,
    replaceSaved: (next: typeof saved) => { saved = next; },
    environment: (next: string) => { environment = next; return controller.environmentChanged(); } };
}

test("HOME remains an accessible Spark workspace tab between Chat and Settings", async () => {
  const h = await fixture(); const chat = h.root.querySelector('[data-learning-tab="chat"]')!;
  navigateLearningTabs(h.root, { target: chat, key: "ArrowRight", preventDefault: vi.fn() });
  const home = h.root.querySelector('[data-learning-tab="home"]')!;
  expect(home.getAttribute("aria-selected")).toBe("true"); expect(h.document.activeElement).toBe(home);
  navigateLearningTabs(h.root, { target: home, key: "ArrowRight", preventDefault: vi.fn() });
  expect(h.root.querySelector('[data-learning-tab="settings"]')?.getAttribute("aria-selected")).toBe("true");
});

test("opening uses HOME-filtered model options and never exposes scheduling controls or saves", async () => {
  const h = await fixture();
  expect(h.field("modelProfileId").value).toBe("");
  expect(h.field("modelProfileId").textContent).toContain("Home model");
  expect(h.root.querySelector('[data-home-setting="enabled"]')).toBeNull();
  expect(h.root.querySelector('[data-home-setting="intervalHours"]')).toBeNull();
  expect(h.root.querySelector('[data-home-setting="fullAccessGranted"]')).toBeNull();
  expect(h.client.listModels).not.toHaveBeenCalled();
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
});

test("save sends only manual HOME settings with the acknowledged revision", async () => {
  const h = await fixture(); h.replaceSaved({ ...h.saved(), revision: 7 }); await h.controller.refresh();
  h.change("personalInstructions", "A calm screen about my projects."); h.change("modelProfileId", "home-model");
  expect(await h.controller.save()).toBe(true);
  expect(h.client.configureSparkHomeSettings).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 7,
    personalInstructions: "A calm screen about my projects.", modelProfileId: "home-model" }, "dev");
  h.controller.change("enabled", true); h.controller.change("intervalHours", 2);
  expect(h.controller.snapshot().changed).toBe(false);
});

test("HOME model labels use the owner DTO without inventing provider availability", async () => {
  const h = await fixture();
  h.replaceSaved({ ...h.saved(), modelProfileId: "gpt-6-astra",
    models: [
      { id: "gpt-6-astra", label: "Astra & research", provider: "openai", providerId: "openai" },
      { id: "ollama-oss", label: "gpt-oss:120b", provider: "ollama", providerId: "ollama" },
      { id: "llamacpp-oss", label: "gpt-oss:120b", provider: "llamacpp", providerId: "llamacpp" },
      { id: "local-ea", label: "", provider: "", providerId: "" },
    ] });
  await h.controller.refresh();
  const selected = h.field("modelProfileId").querySelector('option[value="gpt-6-astra"]')!;
  expect(selected.textContent).toBe("OpenAI - Astra & research");
  expect(selected.disabled).toBe(false);
  expect(h.field("modelProfileId").value).toBe("gpt-6-astra");
  expect(h.field("modelProfileId").querySelector('option[value="local-ea"]')!.textContent).toBe("local-ea");
  expect(h.field("modelProfileId").querySelector('option[value="ollama-oss"]')!.textContent).toBe("Ollama - gpt-oss:120b");
  expect(h.field("modelProfileId").querySelector('option[value="llamacpp-oss"]')!.textContent).toBe("llama.cpp - gpt-oss:120b");
  expect(h.field("modelProfileId").textContent).not.toContain("Provider unavailable");
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
  h.change("modelProfileId", "llamacpp-oss");
  expect(await h.controller.save()).toBe(true);
  expect(h.client.configureSparkHomeSettings).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 0,
    personalInstructions: "", modelProfileId: "llamacpp-oss" }, "dev");
});

test.each([["personalInstructions", "a".repeat(4001)], ["modelProfileId", "super-profile"]])(
  "invalid %s cannot be saved", async (name, value) => {
    const h = await fixture(); h.change(name!, value!); expect(await h.controller.save()).toBe(false);
    expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled(); expect(h.document.activeElement).toBe(h.field(name!));
  },
);

test("a removed or newly ineligible selected model remains visible without silently changing selection", async () => {
  const h = await fixture(); h.replaceSaved({ ...h.saved(), modelProfileId: "removed" }); await h.controller.refresh();
  expect(h.field("modelProfileId").value).toBe("removed");
  expect(h.field("modelProfileId").textContent).toContain("Unavailable");
  h.change("personalInstructions", "Edited"); expect(await h.controller.save()).toBe(false);
  h.change("modelProfileId", "home-model"); expect(await h.controller.save()).toBe(true);
});

test("a settings conflict preserves manual edits and requires explicit reload", async () => {
  const h = await fixture(); h.change("personalInstructions", "My draft");
  h.client.configureSparkHomeSettings.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "spark_home_settings_conflict" }));
  expect(await h.controller.save()).toBe(false);
  expect(h.controller.snapshot()).toMatchObject({ conflict: true, reloadRequired: true, values: { personalInstructions: "My draft" } });
  expect(await h.controller.save()).toBe(false); expect(h.client.configureSparkHomeSettings).toHaveBeenCalledOnce();
  await h.controller.reload(); expect(h.controller.snapshot().values.personalInstructions).toBe("");
});

test("switching environment discards the prior environment's unsaved form", async () => {
  const h = await fixture(); h.change("personalInstructions", "Private draft"); await h.environment("prod");
  expect(h.controller.snapshot()).toMatchObject({ environmentId: "prod", values: { personalInstructions: "" } });
  expect(h.client.configureSparkHomeSettings).not.toHaveBeenCalled();
});
