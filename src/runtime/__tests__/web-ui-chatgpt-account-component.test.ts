import { describe, expect, test, vi } from "vitest";
import { createChatgptAccountConnection } from "../../web-ui/app/components/chatgpt-accounts/connection.js";
import { createRuntimeSetupGuide } from "../../web-ui/app/components/runtime-setup-guide.js";
import { createModelWizardHarness } from "./support/model-setup-wizard-harness.js";
import { chatgptUiClient, connectedChatgptAccount as account } from "./support/chatgpt-account-ui-fixture.js";

describe("shared ChatGPT account component", () => {
  test("a component constructed before backend bootstrap works once local configuration arrives", async () => {
    const harness = createModelWizardHarness(); const client = chatgptUiClient();
    client.supportsChatgptAccounts.mockReturnValue(false);
    const connection = createChatgptAccountConnection({ client });
    connection.mount(harness.root as unknown as HTMLElement);
    expect(client.listChatgptAccounts).not.toHaveBeenCalled();
    client.supportsChatgptAccounts.mockReturnValue(true);
    connection.mount(harness.root as unknown as HTMLElement, { accountRef: account.accountRef });
    await vi.waitFor(() => expect(harness.root.textContent).toContain("ChatGPT plan usage enabled"));
    connection.reset();
  });
  test("the welcome modal dismisses through durable acknowledgement and stays dismissed on remount", async () => {
    const harness = createModelWizardHarness();
    const client = chatgptUiClient([{ ...account, planWelcomeAcknowledged: false }]);
    const connection = createChatgptAccountConnection({ client });
    connection.mount(harness.root as unknown as HTMLElement, { accountRef: account.accountRef });
    await vi.waitFor(() => expect(harness.document.body.querySelector(".chatgpt-plan-welcome")?.open).toBe(true));
    const welcome = harness.document.body.querySelector(".chatgpt-plan-welcome")!;
    welcome.dispatch("cancel");
    await vi.waitFor(() => expect(client.acknowledgeChatgptPlan).toHaveBeenCalled());
    await vi.waitFor(() => expect(harness.document.body.querySelector(".chatgpt-plan-welcome")).toBeNull());
    connection.mount(harness.root as unknown as HTMLElement, { accountRef: account.accountRef });
    expect(harness.document.body.querySelector(".chatgpt-plan-welcome")).toBeNull();
    expect(client.cancelChatgptAttempt).not.toHaveBeenCalled();
    connection.reset();
  });
  test("first-run onboarding mounts the same account chooser and saves its selected registration", async () => {
    const harness = createModelWizardHarness(); const doc = harness.document;
    const container = doc.createElement("section"); doc.body.append(container);
    const region = doc.createElement("section"); doc.body.append(region);
    const client = chatgptUiClient();
    const snapshot = { status: "required" as const, configExists: false, defaultContextWindowTokens: 32768,
      providers: [{ id: "openai-chatgpt" as const, label: "ChatGPT", requiresApiKey: false, credentialConfigured: false }] };
    const saveSetup = vi.fn(async (_input: unknown) => ({ setup: snapshot, activation: { status: "restart_required" as const } }));
    const guide = createRuntimeSetupGuide({
      container: container as unknown as HTMLElement, conversationRegion: region as unknown as HTMLElement,
      chatgptClient: client, loadSetup: async () => ({ setup: snapshot }), saveSetup,
      applySetup: async () => ({ activation: { status: "ready" } }),
      loadEmbeddingStatus: async () => ({}), discoverEmbeddingModels: async () => ({}), saveEmbedding: async () => ({}),
      loadPlugins: async () => ({}), setPlugin: async () => ({}),
    });
    guide.bind(); guide.render({ status: "setup_required" });
    await vi.waitFor(() => expect(container.querySelector('[data-runtime-setup-field="provider"]')).not.toBeNull());
    const provider = container.querySelector('[data-runtime-setup-field="provider"]')!;
    provider.dispatch("change"); container.querySelector("form")!.dispatch("submit");
    await vi.waitFor(() => expect(container.querySelector('[data-chatgpt-field="account"]')?.disabled).toBe(false));
    const select = container.querySelector('[data-chatgpt-field="account"]')!;
    select.value = account.accountRef; select.dispatch("change");
    await vi.waitFor(() => expect(client.listChatgptModels).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.textContent).not.toContain("Updating ChatGPT"));
    const model = container.querySelector('[data-runtime-setup-field="model-id"]')!;
    Object.assign(model, { dispatchEvent(event: Event) { model.dispatch(event.type); return true; } });
    const picker = container.querySelector('[data-chatgpt-field="model"]')!;
    picker.value = "z-model"; picker.dispatch("change");
    expect(model.value).toBe("z-model");
    expect(container.querySelector('[data-runtime-setup-field="context-window"]')!.value).toBe("32768");
    container.querySelector("form")!.dispatch("submit");
    await vi.waitFor(() => expect(saveSetup).toHaveBeenCalled());
    expect(saveSetup).toHaveBeenCalledWith({ provider: "openai-chatgpt", accountRef: account.accountRef, model: "z-model", contextWindowTokens: 32768, deferActivation: true });
    guide.dispose();
  });
});
