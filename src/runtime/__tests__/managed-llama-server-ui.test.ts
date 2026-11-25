import { afterEach, expect, test, vi } from "vitest";
import { createModelWizardHarness, type FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser JavaScript has no declaration surface.
import { createManagedServerDialog } from "../../web-ui/app/components/managed-llama-server/dialog.js";
// @ts-expect-error Browser JavaScript has no declaration surface.
import { createEmbeddingSetupStep } from "../../web-ui/app/components/runtime-setup/embedding.js";
import { createRuntimeSetupGuide } from "../../web-ui/app/components/runtime-setup-guide.js";
import { managedEmbeddingHandoff } from "../../web-ui/managed-llama/server/embedding-handoff.js";

const settings = { startup: "manual", port: 8080, sleepIdleSeconds: 60, maxLoadedModels: 2,
  models: [{ alias: "chat", modelPath: "/synthetic/model.gguf", contextTokens: 4096, gpuLayers: 0 }],
  embedding: { alias: "embed", modelPath: "/synthetic/embedding.gguf", contextTokens: 4096, gpuLayers: 0, port: 8081, pooling: "mean", batchTokens: 512 } };
const server = (extra = {}) => ({ configured: true, supported: true, installation: "installed", busy: false,
  phase: "stopped", ownsProcess: false, legacyOwnsProcess: false, settings: structuredClone(settings), revision: "a".repeat(32), models: [], ...extra });
const client = () => ({ getManagedLlamaServer: vi.fn(async () => ({ server: server() })),
  managedLlamaServerAction: vi.fn(async (_action: string, _input: unknown, _env: string) => ({ server: server() })),
  getManagedLlamaStatus: vi.fn(async () => ({})), managedLlamaAction: vi.fn(async () => ({})) });
async function settle() { for (let n = 0; n < 50; n++) await Promise.resolve(); }
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { promise, resolve }; }
const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); vi.useRealTimers(); });
async function dialogFixture() {
  const h = createModelWizardHarness(); h.wizard.dispose();
  let environment = "dev";
  const api = client(), changed = vi.fn();
  const dialog = createManagedServerDialog({ client: api, getEnvironmentId: () => environment, documentRoot: h.document, onChange: changed });
  closers.push(dialog.close); await dialog.open();
  const element = h.document.body.querySelector(".llama-server-dialog")!;
  return { api, dialog, element, changed, environment: (value: string) => { environment = value; }, document: h.document };
}
const click = (element: FakeElement, action: string) => element.querySelector('[data-llama-action="' + action + '"]')!.dispatch("click");
test("startup and sleep drafts require explicit save; closing and reopening never starts a server", async () => {
  const h = await dialogFixture();
  const mode = h.element.querySelector('[data-llama-field="startup"]')!; mode.value = "with-abot"; mode.dispatch("input");
  const sleep = h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!; sleep.value = "-1"; sleep.dispatch("input");
  h.dialog.close(); await h.dialog.open();
  expect(h.api.managedLlamaServerAction).not.toHaveBeenCalled();
  expect(h.element.innerHTML).toContain("Unsaved settings");
  click(h.element, "save"); await settle();
  expect(h.api.managedLlamaServerAction).toHaveBeenCalledExactlyOnceWith("configure", {
    settings: { ...settings, startup: "with-abot", sleepIdleSeconds: -1 }, revision: "a".repeat(32) }, "dev");
});
test.each([false, true])("dirty draft retains its original revision across external save, refresh and reopen (initially empty: %s)", async initiallyEmpty => {
  vi.useFakeTimers(); const h = await dialogFixture();
  const originalRevision = initiallyEmpty ? null : "a".repeat(32);
  if (initiallyEmpty) {
    h.api.getManagedLlamaServer.mockResolvedValueOnce({ server: server({ configured: false, settings: null, revision: null }) });
    click(h.element, "refresh"); await settle();
    h.api.managedLlamaServerAction.mockResolvedValueOnce({ candidate: { kind: "chat", model: settings.models[0] } } as any);
    for (const [field, value] of [["modelPath", "/synthetic/model.gguf"], ["alias", "chat"]]) {
      const input = h.element.querySelector('[data-llama-field="candidate:' + field + '"]')!; input.value = value!; input.dispatch("input");
    }
    click(h.element, "inspect-model"); await settle(); h.api.managedLlamaServerAction.mockClear();
  }
  const sleep = h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!; sleep.value = "120"; sleep.dispatch("input");
  h.api.getManagedLlamaServer.mockResolvedValue({ server: server({ revision: "b".repeat(32), settings: { ...settings, port: 9090 } }) });
  await vi.advanceTimersByTimeAsync(5000); h.dialog.close(); await h.dialog.open();
  h.api.managedLlamaServerAction.mockRejectedValue(Object.assign(new Error("conflict"), { code: "server_settings_changed" }));
  click(h.element, "save"); await settle();
  expect(h.api.managedLlamaServerAction.mock.calls[0]![1]).toMatchObject({ revision: originalRevision, settings: { port: 8080, sleepIdleSeconds: 120 } });
  expect(h.element.innerHTML).toContain("server_settings_changed");
  click(h.element, "refresh"); await settle(); click(h.element, "save"); await settle();
  expect(h.api.managedLlamaServerAction.mock.calls[1]![1]).toMatchObject({ revision: originalRevision });
});
test("clean refresh and successful save advance the revision used by the next draft", async () => {
  const h = await dialogFixture();
  h.api.getManagedLlamaServer.mockResolvedValue({ server: server({ revision: "b".repeat(32) }) });
  click(h.element, "refresh"); await settle();
  const edit = () => { const input = h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!; input.value = "120"; input.dispatch("input"); };
  edit(); h.api.managedLlamaServerAction.mockResolvedValue({ server: server({ revision: "c".repeat(32), settings: { ...settings, sleepIdleSeconds: 120 } }) });
  click(h.element, "save"); await settle(); edit(); click(h.element, "save"); await settle();
  expect(h.api.managedLlamaServerAction.mock.calls.map(call => (call[1] as any).revision)).toEqual(["b".repeat(32), "c".repeat(32)]);
});
test.each(["conflict", "lost-response"])("explicit discard recovers from %s without retrying a write or starting the server", async failure => {
  const h = await dialogFixture();
  expect(h.element.querySelector('[data-llama-action="discard"]')!.disabled).toBe(true);
  const sleep = h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!; sleep.value = "120"; sleep.dispatch("input");
  const latest = server({ revision: "b".repeat(32), settings: { ...settings,
    port: failure === "conflict" ? 9090 : 8080, sleepIdleSeconds: failure === "conflict" ? 60 : 120 } });
  h.api.getManagedLlamaServer.mockResolvedValue({ server: latest });
  h.api.managedLlamaServerAction.mockRejectedValueOnce(Object.assign(new Error("synthetic save failure"), {
    code: failure === "conflict" ? "server_settings_changed" : "network_error" }));
  click(h.element, "save"); await settle(); click(h.element, "refresh"); await settle();
  expect(h.element.innerHTML).toContain("Unsaved settings");
  expect(h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!.value).toBe("120");
  expect(h.element.querySelector('[data-llama-action="start"]')!.disabled).toBe(true);
  const reads = h.api.getManagedLlamaServer.mock.calls.length;
  click(h.element, "discard"); await settle();
  expect(h.api.getManagedLlamaServer).toHaveBeenCalledTimes(reads + 1);
  expect(h.api.managedLlamaServerAction).toHaveBeenCalledTimes(1);
  expect(h.element.innerHTML).not.toContain("Unsaved settings");
  expect(h.element.querySelector('[data-llama-field="port"]')!.value).toBe(String(latest.settings.port));
  expect(h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!.value).toBe(String(latest.settings.sleepIdleSeconds));
  expect(h.element.querySelector('[data-llama-action="start"]')!.disabled).toBe(false);
  expect(h.element.querySelector('[data-llama-action="discard"]')!.disabled).toBe(true);
  const next = h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!; next.value = "180"; next.dispatch("input");
  click(h.element, "save"); await settle();
  expect(h.api.managedLlamaServerAction.mock.calls[1]![1]).toMatchObject({ revision: latest.revision, settings: { port: latest.settings.port, sleepIdleSeconds: 180 } });
});
test("failed discard reload retains both draft fields and their original revision", async () => {
  const h = await dialogFixture();
  const sleep = h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!; sleep.value = "150"; sleep.dispatch("input");
  h.api.getManagedLlamaServer.mockRejectedValueOnce(new Error("unavailable"));
  click(h.element, "discard"); await settle();
  expect(h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!.value).toBe("150");
  expect(h.element.innerHTML).toContain("Unsaved settings");
  expect(h.element.querySelector('[data-llama-action="discard"]')!.disabled).toBe(false);
  expect(h.api.managedLlamaServerAction).not.toHaveBeenCalled();
  click(h.element, "save"); await settle();
  expect(h.api.managedLlamaServerAction.mock.calls[0]![1]).toMatchObject({ revision: "a".repeat(32), settings: { sleepIdleSeconds: 150 } });
});
test("discard response arriving after close and reopen cannot replace a retained draft", async () => {
  const h = await dialogFixture(), late = deferred();
  const sleep = h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!; sleep.value = "150"; sleep.dispatch("input");
  h.api.getManagedLlamaServer.mockImplementationOnce(() => late.promise);
  click(h.element, "discard"); await settle(); h.dialog.close(); await h.dialog.open();
  late.resolve({ server: server({ revision: "b".repeat(32), settings: { ...settings, port: 9090 } }) }); await settle();
  expect(h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!.value).toBe("150");
  expect(h.element.querySelector('[data-llama-field="port"]')!.value).toBe("8080");
  click(h.element, "save"); await settle();
  expect(h.api.managedLlamaServerAction.mock.calls[0]![1]).toMatchObject({ revision: "a".repeat(32) });
});
test("earlier managed engine has a reachable explicit Stop, without starting the new server", async () => {
  const h = await dialogFixture();
  h.api.getManagedLlamaServer.mockResolvedValueOnce({ server: server({ legacyOwnsProcess: true }) });
  click(h.element, "refresh"); await settle(); click(h.element, "stop-legacy"); await settle();
  expect(h.api.managedLlamaAction).toHaveBeenCalledExactlyOnceWith("stop", {}, "dev");
  expect(h.api.managedLlamaServerAction).not.toHaveBeenCalled();
});
test("late start response cannot undo newer Stop state; late response from another environment is discarded", async () => {
  const h = await dialogFixture(), wait = deferred();
  h.api.managedLlamaServerAction.mockImplementationOnce(() => wait.promise);
  click(h.element, "start"); await settle(); click(h.element, "stop"); await settle();
  const before = h.changed.mock.calls.length;
  wait.resolve({ server: server({ phase: "ready", ownsProcess: true }) }); await settle();
  expect(h.changed).toHaveBeenCalledTimes(before);
  expect(h.element.querySelector('[data-llama-action="start"]')!.disabled).toBe(false);
  const late = deferred(); h.api.getManagedLlamaServer.mockImplementationOnce(() => late.promise);
  click(h.element, "refresh"); h.environment("prod"); await h.dialog.open();
  const after = h.changed.mock.calls.length; late.resolve({ server: server({ phase: "error" }) }); await settle();
  expect(h.changed).toHaveBeenCalledTimes(after);
});
test("background polling updates focused buttons while retaining an edited settings field", async () => {
  vi.useFakeTimers(); const h = await dialogFixture();
  h.element.querySelector('[data-llama-action="refresh"]')!.focus();
  h.api.getManagedLlamaServer.mockResolvedValue({ server: server({ phase: "ready", ownsProcess: true }) });
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.element.querySelector('[data-llama-action="stop"]')!.disabled).toBe(false);
  h.api.getManagedLlamaServer.mockResolvedValue({ server: server() }); click(h.element, "refresh"); await settle();
  const field = h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')!;
  field.focus(); field.value = "123"; field.dispatch("input"); await vi.advanceTimersByTimeAsync(5000);
  expect(h.element.querySelector('[data-llama-field="sleepIdleSeconds"]')).toBe(field); expect(field.value).toBe("123");
});
test("Ollama discovery list keeps scroll and expanded sections through unchanged and changed polls", async () => {
  vi.useFakeTimers(); const h = await dialogFixture();
  h.api.managedLlamaServerAction.mockResolvedValueOnce({ candidates: [{ kind: "chat", model: settings.models[0] }], skipped: [] } as any);
  const details = h.element.querySelector("details")!; details.open = true;
  click(h.element, "discover"); await settle();
  const list = h.element.querySelector(".llama-server-candidates")!;
  h.element.scrollTop = 130;
  h.element.querySelector(".runtime-setup-content")!.scrollTop = 460;
  h.element.querySelector(".llama-server-panel")!.scrollTop = 310;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.element.querySelector(".llama-server-candidates")).toBe(list);
  h.api.getManagedLlamaServer.mockResolvedValue({ server: server({ phase: "error", errorCode: "fixture" }) });
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.element.scrollTop).toBe(130);
  expect(h.element.querySelector(".runtime-setup-content")!.scrollTop).toBe(460);
  expect(h.element.querySelector(".llama-server-panel")!.scrollTop).toBe(310);
  expect(h.element.querySelector("details")!.open).toBe(true);
  expect(h.element.querySelector(".llama-server-candidates")!.textContent).toContain("chat");
});
test("inserting or removing skipped models preserves the identity of expanded details", async () => {
  const h = await dialogFixture();
  const section = (id: string) => h.element.querySelector('[data-llama-section="' + id + '"]')!;
  section("models").open = true; section("advanced").open = true;
  h.element.querySelector(".runtime-setup-content")!.scrollTop = 450;
  h.api.managedLlamaServerAction.mockResolvedValueOnce({ candidates: [], skipped: [{ alias: "unavailable", reason: "fixture" }] } as any);
  click(h.element, "discover"); await settle();
  expect(section("models").open).toBe(true); expect(section("advanced").open).toBe(true); expect(section("skipped").open).toBe(false);
  expect(h.element.querySelector(".runtime-setup-content")!.scrollTop).toBe(450);
  section("advanced").open = false; section("skipped").open = true;
  h.api.managedLlamaServerAction.mockResolvedValueOnce({ candidates: [], skipped: [] } as any);
  click(h.element, "discover"); await settle();
  expect(section("skipped")).toBeNull(); expect(section("advanced").open).toBe(false); expect(section("models").open).toBe(true);
});
test("Models wizard selects a catalog model explicitly and saves its server revision without a credential", async () => {
  const api = client(); api.getManagedLlamaServer.mockResolvedValue({ server: server({ phase: "ready", ownsProcess: true }) });
  const h = createModelWizardHarness({ managedLlamaClient: api }); closers.push(h.wizard.dispose);
  await h.wizard.open(); h.choose("new:llamacpp"); h.click("next");
  const mode = h.dialog.querySelector('[data-managed-llama-field="mode"]')!; mode.value = "managed"; mode.dispatch("change"); await settle();
  const alias = h.dialog.querySelector('[data-managed-llama-field="alias"]')!; alias.value = "chat"; alias.dispatch("change");
  h.dialog.querySelector('[data-managed-llama-action="use"]')!.dispatch("click"); await settle();
  h.click("next"); h.click("finish"); await h.settled();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({ model: "chat", managedLlama: true, managedLlamaRevision: "a".repeat(32) });
  expect(h.requests[0]).not.toHaveProperty("apiKey"); expect(api.managedLlamaServerAction).not.toHaveBeenCalled();
});
test("onboarding forwards the selected server revision through the normal save path", async () => {
  const h = createModelWizardHarness(); h.wizard.dispose();
  const container = h.document.createElement("section"), region = h.document.createElement("section"); h.root.append(container); h.root.append(region);
  const api = client(); api.getManagedLlamaServer.mockResolvedValue({ server: server({ phase: "ready", ownsProcess: true }) });
  const setup = { status: "required" as const, configExists: false, defaultContextWindowTokens: 4096,
    providers: [{ id: "llamacpp" as const, label: "llama.cpp", requiresApiKey: false, credentialConfigured: false }] };
  const saveSetup = vi.fn(async (_input: unknown) => ({ setup, activation: { status: "ready" as const } }));
  const guide = createRuntimeSetupGuide({ container: container as unknown as HTMLElement, conversationRegion: region as unknown as HTMLElement,
    managedLlamaClient: api, loadSetup: async () => ({ setup }), saveSetup, applySetup: async () => ({ activation: { status: "ready" } }),
    loadEmbeddingStatus: async () => ({}), discoverEmbeddingModels: async () => ({}), saveEmbedding: async () => ({}),
    loadPlugins: async () => ({ plugins: [] }), setPlugin: async () => ({}) });
  closers.push(guide.dispose); guide.bind(); guide.render({ status: "setup_required", showGuide: true }); await settle();
  container.querySelector('[data-runtime-setup-field="provider"][value="llamacpp"]')!.dispatch("change"); container.querySelector("form")!.dispatch("submit");
  const mode = container.querySelector('[data-managed-llama-field="mode"]')!; mode.value = "managed"; mode.dispatch("change"); await settle();
  const alias = container.querySelector('[data-managed-llama-field="alias"]')!; alias.value = "chat"; alias.dispatch("change");
  container.querySelector('[data-managed-llama-action="use"]')!.dispatch("click"); await settle(); container.querySelector("form")!.dispatch("submit"); await settle();
  expect(saveSetup).toHaveBeenCalledOnce(); expect(saveSetup.mock.calls[0]![0]).toMatchObject({ managedLlama: true, managedLlamaRevision: "a".repeat(32), model: "chat" });
});
test("managed embeddings require explicit selection and save; editing returns to manual without a hidden credential flag", async () => {
  const changes = vi.fn(), requests: any[] = [];
  const step = createEmbeddingSetupStep({ container: { querySelector: () => null }, getEnvironmentId: () => "dev",
    loadStatus: async () => ({ status: { enabled: false, providers: [] } }), loadManagedServer: async () => ({ server: server({ phase: "ready" }) }),
    discoverModels: vi.fn(), saveEmbedding: async (input: any) => { requests.push({ ...input }); return { status: { enabled: true, model: input.model } }; },
    onChange: changes, onComplete: vi.fn() });
  await step.load(); expect(requests).toEqual([]); step.click("embedding-managed");
  expect(step.markup()).not.toContain('data-runtime-setup-field="embedding-key"');
  await step.submit(); expect(requests[0]).toMatchObject({ managedLlamaEmbedding: true, managedLlamaRevision: "a".repeat(32), useApiKey: true });
  expect(requests[0]).not.toHaveProperty("apiKey");
  step.click("embedding-managed"); const before = changes.mock.calls.length; step.input("embedding-model", "manual-model");
  expect(changes).toHaveBeenCalledTimes(before + 1); expect(step.state.managedLlamaEmbedding).toBe(false); expect(step.state.useApiKey).toBe(false);
  expect(step.markup()).toContain('data-runtime-setup-field="embedding-key"');
  await step.submit(); expect(requests[1]).not.toHaveProperty("managedLlamaEmbedding"); expect(requests[1].useApiKey).toBe(false);
});
test.each([true, false])("embedding retries adopt only a verified saved-provider receipt (valid: %s)", async validReceipt => {
  const requests: any[] = [], resolved: any[] = [], onComplete = vi.fn();
  const handoff = managedEmbeddingHandoff({ embeddingConnection: () => ({ model: "embed", baseUrl: "http://127.0.0.1:8081",
    contextWindowTokens: 4096, apiKey: "server-only-secret", revision: "a".repeat(32) }) });
  const step = createEmbeddingSetupStep({ container: { querySelector: () => null }, getEnvironmentId: () => "dev",
    loadStatus: async () => ({ status: { enabled: false, providers: [] } }), loadManagedServer: async () => ({ server: server({ phase: "ready" }) }),
    discoverModels: vi.fn(), saveEmbedding: async (input: any) => {
      requests.push({ ...input }); resolved.push(handoff(input));
      if (requests.length === 1) throw Object.assign(new Error("probe failed"), { payload: {
        providerSaved: true, savedProvider: { id: validReceipt ? input.newProviderId : "wrong-provider", type: "llamacpp", credentialConfigured: true } } });
      return { status: { enabled: true, providerId: "llamacpp-embedding", model: input.model } };
    }, onChange: vi.fn(), onComplete });
  await step.load(); step.click("embedding-managed"); await step.submit();
  expect(onComplete).not.toHaveBeenCalled(); expect(step.state.managedLlamaEmbedding).toBe(!validReceipt);
  await step.submit(); expect(onComplete).toHaveBeenCalledOnce();
  if (validReceipt) {
    expect(requests[1]).toEqual({ providerId: "llamacpp-embedding", model: "embed" });
    expect(resolved[1]).not.toHaveProperty("apiKey");
  } else expect(requests[1]).toMatchObject({ managedLlamaEmbedding: true, provider: "llamacpp" });
  expect(step.state.managedLlamaEmbedding).toBe(false);
  expect(step.markup()).not.toContain("server-only-secret");
});
