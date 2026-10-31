import { describe, expect, test, vi } from "vitest";
import { createModelWizardHarness, modelSetupCatalog } from "./support/model-setup-wizard-harness.js";
import { chatgptUiClient, connectedChatgptAccount as account } from "./support/chatgpt-account-ui-fixture.js";
import { renderChatgptAccounts, chatgptAuthorizationUrl } from "../../web-ui/app/components/chatgpt-accounts/rendering.js";
import { runtimeSetupConnectionInput } from "../../web-ui/app/components/runtime-setup/connection-input.js";
import { renderConnectionFields } from "../../web-ui/app/components/runtime-setup/connection-form.js";

describe("ChatGPT connection setup", () => {
  test("add-model uses an existing pinned registration and leaves the key input absent", async () => {
    const client = chatgptUiClient();
    const harness = createModelWizardHarness({ chatgptClient: client, loadSetup: async () => ({
      ...modelSetupCatalog, providers: [{ id: "chatgpt", type: "openai-chatgpt", label: "Personal ChatGPT", accountRef: account.accountRef, requiresApiKey: false, credentialConfigured: false }],
    }) });
    await harness.wizard.open({ providerId: "chatgpt" });
    await vi.waitFor(() => expect(client.listChatgptModels).toHaveBeenCalled());
    await vi.waitFor(() => expect(harness.dialog.textContent).not.toContain("Updating ChatGPT"));
    expect(harness.field("api-key")).toBeNull();
    expect(harness.dialog.querySelector('[data-chatgpt-field="account"]')?.disabled).toBe(true);
    harness.input("model-id", "z-model"); harness.input("context-window", "48000");
    harness.click("next"); harness.click("finish"); await harness.settled();
    expect(harness.requests[0]).toEqual({ providerId: "chatgpt", profileId: "z-model", model: "z-model", contextWindowTokens: 48000 });
  });
  test("uses the official decorative mark on the shared sign-in button and provider entry", async () => {
    const client = chatgptUiClient();
    const harness = createModelWizardHarness({ chatgptClient: client });
    await harness.wizard.open();
    const provider = harness.dialog.querySelector('[data-runtime-setup-field="provider"][value="new:openai-chatgpt"]')!;
    expect(provider.parentElement!.querySelector(".chatgpt-logo")?.attributes.get("src")).toBe("/chatgpt-logo-white.svg");
    harness.choose("new:openai-chatgpt"); harness.click("next");
    await vi.waitFor(() => expect(harness.dialog.querySelector('[data-chatgpt-action="sign-in"]')?.disabled).toBe(false));
    const button = harness.dialog.querySelector('[data-chatgpt-action="sign-in"]')!;
    const logo = button.querySelector("img")!;
    expect(button.textContent).toBe("Continue with ChatGPT");
    expect(logo.attributes.get("src")).toBe("/chatgpt-logo-white.svg");
    expect(logo.attributes.get("alt")).toBe("");
    expect(logo.attributes.get("aria-hidden")).toBe("true");
    expect(harness.dialog.querySelectorAll("option").every((option) => option.querySelector("img") === null)).toBe(true);
    harness.wizard.close();
  });
  test("new provider carries the selected accountRef and no API key", async () => {
    const client = chatgptUiClient();
    const harness = createModelWizardHarness({ chatgptClient: client });
    await harness.wizard.open(); harness.choose("new:openai-chatgpt"); harness.click("next");
    await vi.waitFor(() => expect(harness.dialog.querySelector('[data-chatgpt-field="account"]')?.disabled).toBe(false));
    const select = harness.dialog.querySelector('[data-chatgpt-field="account"]')!;
    select.value = account.accountRef; select.dispatch("change");
    await vi.waitFor(() => expect(client.listChatgptModels).toHaveBeenCalled());
    await vi.waitFor(() => expect(harness.dialog.textContent).not.toContain("Updating ChatGPT"));
    harness.input("model-id", "z-model"); harness.input("context-window", "24000");
    harness.click("next"); harness.click("finish"); await harness.settled();
    expect(harness.requests[0]?.newProvider).toEqual({ id: "openai-chatgpt", type: "openai-chatgpt", accountRef: account.accountRef });
    expect(harness.requests[0]).not.toHaveProperty("apiKey");
    expect(harness.requests[0]).not.toHaveProperty("supportsThinking");
  });
  test("initial setup validates the account and sends only its opaque reference", () => {
    const state = { provider: "openai-chatgpt", providers: [], modelId: "z-model", contextWindowTokens: "12000", accountRef: account.accountRef, chatgptAccountReady: true };
    const container = { querySelector: vi.fn(() => { throw new Error("OAuth must not read a secret input"); }) };
    expect(runtimeSetupConnectionInput(state, container, vi.fn())).toEqual({ provider: "openai-chatgpt", model: "z-model", contextWindowTokens: 12000, accountRef: account.accountRef });
    expect(renderConnectionFields({ ...state, modelId: state.modelId })).not.toContain('field="api-key"');
    expect(runtimeSetupConnectionInput({ ...state, chatgptAccountReady: false }, container, vi.fn())).toBeNull();
  });
  test("account data is escaped and ID-token hints cannot enter the browser launch link", () => {
    const markup = renderChatgptAccounts({ accounts: [{ ...account, label: '<img src=x onerror="bad">' }], accountRef: account.accountRef, models: [], busy: "", error: "", notice: "", attempt: null, loaded: true });
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("Continue with ChatGPT");
    expect(markup).toContain("https://chatgpt.com/settings/usage");
    expect(chatgptAuthorizationUrl("https://auth.openai.com/api/accounts/authorize?id_token_hint=secret")).toBe("");
    expect(chatgptAuthorizationUrl("https://example.com/authorize")).toBe("");
  });
});
