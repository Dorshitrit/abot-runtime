import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { createChatgptAccountConnection } from "../../web-ui/app/components/chatgpt-accounts/connection.js";
import { chatgptUiClient, pendingChatgptResult } from "./support/chatgpt-account-ui-fixture.js";
import { createModelWizardHarness } from "./support/model-setup-wizard-harness.js";
import { openChatgptSetupFlow } from "./support/chatgpt-setup-lifecycle-fixture.js";

afterEach(() => vi.useRealTimers());

const setupFlows = ["first-run", "add-model"] as const;

describe("ChatGPT setup account progress", () => {
  test.each(setupFlows)("%s settles failed account loading and retries only on request", async (kind) => {
    const client = chatgptUiClient([]);
    const retry = pendingChatgptResult<Awaited<ReturnType<typeof client.listChatgptAccounts>>>();
    client.listChatgptAccounts.mockRejectedValueOnce(new Error("Forbidden"));
    // Bound the old automatic retry loop without concealing the extra request.
    client.listChatgptAccounts.mockReturnValue(retry.promise);
    const flow = await openChatgptSetupFlow(kind, client);
    onTestFinished(flow.close);
    await vi.waitFor(() => expect(client.listChatgptAccounts).toHaveBeenCalled());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.listChatgptAccounts).toHaveBeenCalledTimes(1);
    expect(flow.container.textContent).toContain("accounts could not be loaded");
    expect(flow.container.textContent).not.toContain("Updating ChatGPT");
    flow.refresh();
    expect(client.listChatgptAccounts).toHaveBeenCalledTimes(1);
    flow.container.querySelector('[data-chatgpt-action="reload"]')!.dispatch("click");
    expect(client.listChatgptAccounts).toHaveBeenCalledTimes(2);
    retry.resolve({ ok: true, accounts: [] });
    await vi.waitFor(() => expect(flow.container.textContent).not.toContain("Updating ChatGPT"));
    expect(flow.container.textContent).not.toContain("accounts could not be loaded");
    expect(flow.container.querySelector('[data-chatgpt-action="sign-in"]')!.disabled).toBe(false);
  });

  test.each(setupFlows)("%s preserves input elements and drafts during pending sign-in polls", async (kind) => {
    vi.useFakeTimers();
    const client = chatgptUiClient([]);
    const flow = await openChatgptSetupFlow(kind, client);
    onTestFinished(flow.close);
    await vi.waitFor(() => expect(flow.container.querySelector('[data-chatgpt-action="sign-in"]')!.disabled).toBe(false));
    client.getChatgptAttempt.mockResolvedValue({ ok: true, attempt: {
      attemptId: "attempt-a", status: "pending", expiresAt: Date.now() + 60000,
    } });
    flow.container.querySelector('[data-chatgpt-action="sign-in"]')!.dispatch("click");
    await vi.advanceTimersByTimeAsync(0);
    const model = flow.container.querySelector('[data-runtime-setup-field="model-id"]')!;
    const context = flow.container.querySelector('[data-runtime-setup-field="context-window"]')!;
    model.value = "draft-model";
    model.dispatch("input");
    context.value = "48000";
    context.dispatch("input");
    model.focus();
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.getChatgptAttempt).toHaveBeenCalledTimes(3);
    expect(flow.container.querySelector('[data-runtime-setup-field="model-id"]') === model).toBe(true);
    expect(flow.container.querySelector('[data-runtime-setup-field="context-window"]') === context).toBe(true);
    expect(flow.document.activeElement === model).toBe(true);
    expect(model.value).toBe("draft-model");
    expect(context.value).toBe("48000");
    model.value = "draft-model-edited";
    model.dispatch("input");
    expect(flow.container.querySelector('[data-runtime-setup-field="model-id"]')!.value).toBe("draft-model-edited");
    expect(client.listChatgptAccounts).toHaveBeenCalledTimes(1);
  });

  test("switching environment permits one fresh account read after a failure", async () => {
    let environment = "dev";
    const client = chatgptUiClient([]);
    client.listChatgptAccounts.mockRejectedValueOnce(new Error("Forbidden"));
    const harness = createModelWizardHarness();
    const connection = createChatgptAccountConnection({ client, getEnvironmentId: () => environment });
    onTestFinished(connection.reset);
    const mount = () => connection.mount(harness.root as unknown as HTMLElement);
    mount();
    await vi.waitFor(() => expect(harness.root.textContent).toContain("accounts could not be loaded"));
    mount();
    expect(client.listChatgptAccounts).toHaveBeenCalledTimes(1);
    environment = "prod";
    mount();
    await vi.waitFor(() => expect(harness.root.textContent).not.toContain("Updating ChatGPT"));
    expect(client.listChatgptAccounts).toHaveBeenCalledTimes(2);
    expect(harness.root.textContent).not.toContain("accounts could not be loaded");
  });
});
