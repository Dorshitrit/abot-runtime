import { expect, test, vi } from "vitest";
import { createModelWizardHarness, type FakeElement } from "./support/model-setup-wizard-harness.js";
import { createRuntimeSetupGuide } from "../../web-ui/app/components/runtime-setup-guide.js";
import { createManagedLlamaHandoff } from "../../web-ui/managed-llama/configuration-handoff.js";

const settings = { modelPath: "/synthetic/model.gguf", alias: "managed-model", port: 8080, contextTokens: 4096, gpuLayers: 0 };
const connection = { model: settings.alias, baseUrl: "http://127.0.0.1:8080", contextWindowTokens: 4096, apiKey: "synthetic-private-key" };
function client() {
  const status = { supported: true, closed: false, phase: "idle", installation: "installed", ownsProcess: false, preferences: settings };
  return {
    getManagedLlamaStatus: vi.fn(async () => ({ ok: true, status, capabilities: { release: { size: 100 } } })),
    managedLlamaAction: vi.fn(async (_action: string) => ({ ok: true, status: { ...status, phase: "ready", ownsProcess: true } })),
  };
}
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function startAndUse(container: FakeElement) {
  const mode = container.querySelector('[data-managed-llama-field="mode"]')!;
  expect(mode).not.toBeNull();
  mode.value = "managed"; mode.dispatch("change");
  await settle();
  container.querySelector('[data-managed-llama-action="start"]')!.dispatch("click");
  await settle();
  container.querySelector('[data-managed-llama-action="use"]')!.dispatch("click");
  await settle();
}

test("Models wizard starts explicitly and saves a managed provider without a browser credential", async () => {
  const managedLlamaClient = client();
  const h = createModelWizardHarness({ managedLlamaClient });
  await h.wizard.open(); h.choose("new:llamacpp"); h.click("next");
  expect(managedLlamaClient.getManagedLlamaStatus).not.toHaveBeenCalled();
  await startAndUse(h.dialog);
  expect(managedLlamaClient.managedLlamaAction).toHaveBeenCalledExactlyOnceWith("start", settings, "");
  h.click("next"); h.click("finish"); await h.settled();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({ managedLlama: true, model: settings.alias, newProvider: { type: "llamacpp" } });
  expect(h.requests[0]).not.toHaveProperty("apiKey");
  const resolved = createManagedLlamaHandoff("models", () => connection)(h.requests[0]);
  expect(resolved).toMatchObject({ apiKey: connection.apiKey, newProvider: { useApiKey: true } });
  expect(h.dialog.innerHTML).not.toContain(connection.apiKey);
});

test("onboarding uses the same explicit engine flow and preserves managed save intent", async () => {
  const h = createModelWizardHarness(); h.wizard.dispose();
  const container = h.document.createElement("section"); h.root.append(container);
  const region = h.document.createElement("section"); h.root.append(region);
  const managedLlamaClient = client();
  const setup = { status: "required" as const, configExists: false, defaultContextWindowTokens: 4096,
    providers: [{ id: "llamacpp" as const, label: "llama.cpp", requiresApiKey: false, credentialConfigured: false }] };
  const saveSetup = vi.fn(async (_input: unknown) => ({ setup, activation: { status: "ready" as const } }));
  const guide = createRuntimeSetupGuide({
    container: container as unknown as HTMLElement, conversationRegion: region as unknown as HTMLElement,
    managedLlamaClient, loadSetup: async () => ({ setup }), saveSetup,
    applySetup: async () => ({ activation: { status: "ready" } }),
    loadEmbeddingStatus: async () => ({}), discoverEmbeddingModels: async () => ({}), saveEmbedding: async () => ({}),
    loadPlugins: async () => ({ plugins: [] }), setPlugin: async () => ({}),
  });
  guide.bind(); guide.render({ status: "setup_required", showGuide: true }); await settle();
  container.querySelector('[data-runtime-setup-field="provider"][value="llamacpp"]')!.dispatch("change");
  container.querySelector("form")!.dispatch("submit");
  await startAndUse(container);
  container.querySelector("form")!.dispatch("submit"); await settle();
  expect(saveSetup).toHaveBeenCalledOnce();
  const input = saveSetup.mock.calls[0][0] as Record<string, unknown>;
  expect(input).toMatchObject({ managedLlama: true, provider: "llamacpp", model: settings.alias });
  expect(input).not.toHaveProperty("apiKey");
  expect(createManagedLlamaHandoff("runtime", () => connection)(input)).toMatchObject(connection);
  expect(container.innerHTML).not.toContain(connection.apiKey);
  guide.dispose();
});
