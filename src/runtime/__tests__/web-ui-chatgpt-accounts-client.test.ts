import { describe, expect, test, vi } from "vitest";
import { createChatgptAccountRequests } from "../../web-ui/app/services/runtime-web-client/chatgpt-accounts.js";
describe("ChatGPT account transport", () => {
  test("uses local backend routes and opaque registration IDs", async () => {
    const requestApi = vi.fn(async (_path: string, _options?: RequestInit) => ({}));
    const client = createChatgptAccountRequests({ requestApi, getConfig: () => ({ backend: "runtime" }) });
    await client.startChatgptAttempt({ accountRef: "account/a", purpose: "sign_in" });
    await client.listChatgptModels("account/a");
    await client.acknowledgeChatgptPlan("account/a");
    expect(requestApi.mock.calls.map(([path]) => path)).toEqual([
      "/runtime/chatgpt/attempts", "/runtime/chatgpt/accounts/account%2Fa/models", "/runtime/chatgpt/accounts/account%2Fa/acknowledge-plan",
    ]);
    expect(requestApi).toHaveBeenNthCalledWith(1, "/runtime/chatgpt/attempts", expect.objectContaining({ method: "POST", body: '{"accountRef":"account/a","purpose":"sign_in"}' }));
  });
  test("bridge mode never dispatches account management", () => {
    const requestApi = vi.fn(async (_path: string, _options?: RequestInit) => ({}));
    const client = createChatgptAccountRequests({ requestApi, getConfig: () => ({ backend: "bridge" }) });
    expect(() => client.listChatgptAccounts()).toThrow("local Runtime");
    expect(requestApi).not.toHaveBeenCalled();
  });
});
