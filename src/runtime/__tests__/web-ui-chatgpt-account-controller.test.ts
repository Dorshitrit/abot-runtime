import { afterEach, describe, expect, test, vi } from "vitest";
import { createChatgptAccountController } from "../../web-ui/app/controllers/chatgpt-account-controller.js";
import { chatgptUiClient, connectedChatgptAccount as account, pendingChatgptResult } from "./support/chatgpt-account-ui-fixture.js";

afterEach(() => vi.useRealTimers());
describe("ChatGPT account UI lifecycle", () => {
  test("keeps registrations with the same email separate and preserves model order without inventing limits", async () => {
    const client = chatgptUiClient([account, { ...account, accountRef: "registration-b", label: "Work" }]);
    const flow = createChatgptAccountController({ client });
    await flow.load(); expect(flow.state.accountRef).toBe("");
    await flow.select("registration-b");
    expect(flow.state.accounts).toHaveLength(2);
    expect(flow.canUseAccount()).toBe(true);
    expect(client.listChatgptModels).toHaveBeenCalledWith("registration-b", expect.anything());
    expect(flow.state.models.map((model) => model.id)).toEqual(["z-model", "a-model"]);
    expect(flow.state.models[0]).not.toHaveProperty("contextWindow");
  });
  test("identity-only sign-in remains visible but cannot provide inference or a model catalog", async () => {
    const client = chatgptUiClient([{ ...account, status: "identity_only", planEnabled: false }]);
    const flow = createChatgptAccountController({ client });
    await flow.load(account.accountRef);
    expect(flow.account()?.status).toBe("identity_only");
    expect(flow.canUseAccount()).toBe(false);
    expect(client.listChatgptModels).not.toHaveBeenCalled();
    await flow.start("enable_plan_usage");
    expect(client.startChatgptAttempt).toHaveBeenCalledWith({ accountRef: account.accountRef, purpose: "enable_plan_usage" }, expect.anything());
    flow.reset();
  });
  test("cancel stops polling and rejects an in-flight completion", async () => {
    vi.useFakeTimers();
    const client = chatgptUiClient();
    const response = pendingChatgptResult<Awaited<ReturnType<typeof client.getChatgptAttempt>>>();
    client.getChatgptAttempt.mockReturnValueOnce(response.promise);
    const flow = createChatgptAccountController({ client });
    await flow.start(); await vi.advanceTimersByTimeAsync(1000);
    await flow.cancel();
    response.resolve({ ok: true, attempt: { attemptId: "attempt-a", status: "complete", accountRef: account.accountRef, expiresAt: Date.now() + 60_000 } });
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(5000);
    expect(client.cancelChatgptAttempt).toHaveBeenCalledWith("attempt-a");
    expect(client.listChatgptAccounts).not.toHaveBeenCalled();
    expect(flow.state.accountRef).toBe("");
    expect(flow.state.attempt).toBeNull();
  });
  test("late begin after disposal is cancelled and never opens a browser", async () => {
    const client = chatgptUiClient(); const openAuthorization = vi.fn();
    const response = pendingChatgptResult<Awaited<ReturnType<typeof client.startChatgptAttempt>>>();
    client.startChatgptAttempt.mockReturnValueOnce(response.promise);
    const flow = createChatgptAccountController({ client, openAuthorization });
    const started = flow.start(); flow.reset();
    response.resolve({ ok: true, attempt: { attemptId: "late", status: "pending", expiresAt: Date.now() + 1000 } });
    await started;
    expect(client.cancelChatgptAttempt).toHaveBeenCalledWith("late");
    expect(openAuthorization).not.toHaveBeenCalled();
  });
  test("an environment switch rejects prior account reads", async () => {
    let environment = "dev";
    const client = chatgptUiClient();
    const response = pendingChatgptResult<Awaited<ReturnType<typeof client.listChatgptAccounts>>>();
    client.listChatgptAccounts.mockReturnValueOnce(response.promise);
    const flow = createChatgptAccountController({ client, getEnvironmentId: () => environment });
    const loaded = flow.load(account.accountRef);
    environment = "prod";
    response.resolve({ ok: true, accounts: [account] }); await loaded;
    expect(flow.state.accounts).toEqual([]);
    expect(flow.canUseAccount()).toBe(false);
    expect(client.listChatgptModels).not.toHaveBeenCalled();
  });
  test("validated completion selects only its registration and acknowledgement comes from the server", async () => {
    vi.useFakeTimers();
    const client = chatgptUiClient([{ ...account, planWelcomeAcknowledged: false }]);
    const flow = createChatgptAccountController({ client });
    await flow.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(flow.state.accountRef).toBe(account.accountRef);
    expect(flow.account()?.planWelcomeAcknowledged).toBe(false);
    await flow.acknowledge();
    expect(client.acknowledgeChatgptPlan).toHaveBeenCalledWith(account.accountRef, expect.anything());
    expect(flow.account()?.planWelcomeAcknowledged).toBe(true);
  });
  test("explicit retry reuses the failed attempt handle without starting a new registration", async () => {
    vi.useFakeTimers();
    const client = chatgptUiClient();
    client.getChatgptAttempt.mockResolvedValueOnce({ ok: true, attempt: { attemptId: "attempt-a", status: "failed", retryable: true, expiresAt: Date.now() + 60_000 } });
    const flow = createChatgptAccountController({ client });
    await flow.start(); await vi.advanceTimersByTimeAsync(1000);
    await flow.retry();
    expect(client.retryChatgptAttempt).toHaveBeenCalledWith("attempt-a", expect.anything());
    expect(client.startChatgptAttempt).toHaveBeenCalledTimes(1);
    flow.reset();
  });
  test("sign-out reports unconfirmed revocation while keeping the account registration", async () => {
    const client = chatgptUiClient();
    client.disconnectChatgptAccount.mockResolvedValueOnce({ ok: true, result: { revocationConfirmed: false } });
    const flow = createChatgptAccountController({ client });
    await flow.load(account.accountRef);
    client.listChatgptAccounts.mockResolvedValueOnce({ ok: true, accounts: [{ ...account, status: "signed_out", planEnabled: false }] });
    await flow.disconnect();
    expect(flow.account()?.accountRef).toBe(account.accountRef);
    expect(flow.canUseAccount()).toBe(false);
    expect(flow.state.notice).toContain("Remote revocation was not confirmed");
  });
});
