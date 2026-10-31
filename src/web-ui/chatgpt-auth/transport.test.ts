import { createHash } from "node:crypto";
import { describe, expect, onTestFinished, test } from "vitest";
import { ChatGptAuthService } from "../../provider-auth/chatgpt/service.js";
import { chatgptWebTransportFixture } from "./__tests__/transport-fixture.js";

describe("ChatGPT OAuth through the Web UI transport", () => {
  test.each([true, false])("completes signed OAuth and persists credentials with published=%s", async (published) => {
    const f = await chatgptWebTransportFixture({ published });
    const { attempt } = await f.client.startChatgptAttempt({ purpose: "sign_in" });
    const authorization = new URL(attempt.authorizationUrl!);
    const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(redirect.pathname).toBe("/auth/callback");
    if (published) {
      expect(redirect.origin).toBe(f.origin);
      expect(redirect.origin).not.toBe(f.backendOrigin);
    } else {
      expect(redirect.origin).not.toBe(f.origin);
    }
    const callback = await f.complete(attempt, "CALLBACK_SECRET");
    expect(callback.status).toBe(200);
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(await callback.text()).not.toContain("CALLBACK_SECRET");
    const completed = await f.client.getChatgptAttempt(attempt.attemptId);
    expect(completed.attempt.status).toBe("complete");
    expect(completed.attempt.authorizationUrl).toBeUndefined();
    const accounts = await f.client.listChatgptAccounts();
    expect(accounts.accounts).toHaveLength(1);
    const accountRef = accounts.accounts[0]!.accountRef;
    expect(accounts.accounts[0]).toMatchObject({ accountRef: completed.attempt.accountRef, status: "connected", planEnabled: true });
    const models = await f.client.listChatgptModels(accountRef);
    expect(models.models.map((model) => model.id)).toEqual(["visible-b", "visible-a"]);
    expect(JSON.stringify([accounts, completed, models])).not.toMatch(/ACCESS|REFRESH|id_token|clientId|nonce|verifier/);
    const tokenCalls = f.provider.calls.filter((call) => call.url.endsWith("/oauth/token"));
    expect(tokenCalls).toHaveLength(1);
    const tokenForm = new URLSearchParams(String(tokenCalls[0]!.init?.body));
    expect(tokenForm.get("redirect_uri")).toBe(redirect.href);
    expect(tokenForm.get("client_id")).toBe("oaiapp_fixture");
    expect(createHash("sha256").update(tokenForm.get("code_verifier")!).digest("base64url"))
      .toBe(authorization.searchParams.get("code_challenge"));
    const reopened = new ChatGptAuthService({ directory: f.provider.directory, fetchImpl: f.provider.fetchImpl, now: f.provider.now });
    onTestFinished(() => reopened.close());
    expect(await reopened.listAccounts()).toEqual(accounts.accounts);
    expect(await reopened.getAccessToken(accountRef)).toBe("ACCESS-0");
  });

  test("published account management stays unavailable without explicit owner trust", async () => {
    const f = await chatgptWebTransportFixture({ allowPublishedLoopback: false });
    await expect(f.client.listChatgptAccounts()).rejects.toMatchObject({ code: "chatgpt_local_only" });
    await expect(f.client.startChatgptAttempt({ purpose: "sign_in" })).rejects.toMatchObject({ code: "chatgpt_local_only" });
    expect(f.provider.calls).toEqual([]);
  });

  test("rejects wrong and duplicate state without consuming the pending attempt", async () => {
    const f = await chatgptWebTransportFixture();
    const { attempt } = await f.client.startChatgptAttempt({ purpose: "sign_in" });
    const authorization = new URL(attempt.authorizationUrl!);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.search = "state=wrong&code=unused";
    expect((await fetch(callback)).status).toBeGreaterThanOrEqual(400);
    callback.search = new URLSearchParams({ state: authorization.searchParams.get("state")!, code: "unused", client_id: "oaiapp_fixture" }).toString();
    callback.searchParams.append("state", "duplicate");
    expect((await fetch(callback)).status).toBeGreaterThanOrEqual(400);
    expect(f.provider.calls.some((call) => call.url.endsWith("/oauth/token"))).toBe(false);
    expect((await f.client.getChatgptAttempt(attempt.attemptId)).attempt.status).toBe("pending");
    expect((await f.complete(attempt)).status).toBe(200);
    expect((await f.complete(attempt)).status).toBeGreaterThanOrEqual(400);
    expect(f.provider.calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(1);
  });

  test("cancelling one published callback preserves another pending attempt and the listener", async () => {
    const f = await chatgptWebTransportFixture();
    const first = (await f.client.startChatgptAttempt({ purpose: "sign_in" })).attempt;
    const second = (await f.client.startChatgptAttempt({ purpose: "sign_in" })).attempt;
    await f.client.cancelChatgptAttempt(first.attemptId);
    expect((await f.complete(first)).status).toBeGreaterThanOrEqual(400);
    expect((await f.complete(second)).status).toBe(200);
    expect((await f.client.listChatgptAccounts()).accounts).toHaveLength(1);
    expect((await f.client.getChatgptAttempt(first.attemptId)).attempt.status).toBe("cancelled");
    expect(f.provider.calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(1);
  });

  test("expired published callbacks never exchange tokens or persist an account", async () => {
    const f = await chatgptWebTransportFixture();
    const { attempt } = await f.client.startChatgptAttempt({ purpose: "sign_in" });
    f.provider.advance(600001);
    expect((await f.complete(attempt)).status).toBeGreaterThanOrEqual(400);
    expect((await f.client.getChatgptAttempt(attempt.attemptId)).attempt.status).toBe("cancelled");
    expect((await f.client.listChatgptAccounts()).accounts).toEqual([]);
    expect(f.provider.calls.some((call) => call.url.endsWith("/oauth/token"))).toBe(false);
  });

  test("explicit retry keeps the published callback transport and issued client identity", async () => {
    const f = await chatgptWebTransportFixture();
    const first = (await f.client.startChatgptAttempt({ purpose: "sign_in" })).attempt;
    f.provider.tokenError("invalid_grant");
    expect((await f.complete(first)).status).toBeGreaterThanOrEqual(400);
    expect((await f.client.getChatgptAttempt(first.attemptId)).attempt).toMatchObject({ status: "failed", retryable: true });
    f.provider.tokenError(undefined);
    const retried = (await f.client.retryChatgptAttempt(first.attemptId)).attempt;
    const authorization = new URL(retried.authorizationUrl!);
    expect(new URL(authorization.searchParams.get("redirect_uri")!).origin).toBe(f.origin);
    expect(authorization.searchParams.get("client_id")).toBe("oaiapp_fixture");
    expect((await f.complete(retried)).status).toBe(200);
    expect((await f.client.listChatgptAccounts()).accounts).toHaveLength(1);
  });
});
