import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { authFixture } from "./fixture.js";
const fixtures: Awaited<ReturnType<typeof authFixture>>[] = [];
async function fixture() {
  const value = await authFixture();
  fixtures.push(value);
  return value;
}
afterEach(() => {
  for (const value of fixtures.splice(0)) value.service.close();
});
describe("local ChatGPT authorization", () => {
  it("binds PKCE, state, nonce, issued client and persists no secrets in browser summaries", async () => {
    const f = await fixture();
    const started = await f.begin();
    expect(started.url.searchParams.get("client_id")).toBe(
      "dynamic_agent_client",
    );
    expect(started.url.searchParams.get("agent_name_hint")).toBe("ABot");
    expect(started.url.searchParams.get("id_token_hint")).toBeNull();
    expect(started.url.searchParams.get("code_challenge_method")).toBe("S256");
    await expect(
      started.consume(
        new URLSearchParams({
          state: "wrong",
          code: "code",
          client_id: "oaiapp_fixture",
        }),
      ),
    ).rejects.toMatchObject({ code: "chatgpt_state_invalid" });
    expect(f.calls.some((call) => call.url.endsWith("/oauth/token"))).toBe(
      false,
    );
    await started.consume(
      new URLSearchParams({
        state: started.url.searchParams.get("state")!,
        code: "code",
        client_id: "oaiapp_fixture",
      }),
    );
    const result = f.service.getAttempt(started.attempt.attemptId);
    expect(result).toMatchObject({ status: "complete" });
    expect(result.authorizationUrl).toBeUndefined();
    const accounts = await f.service.listAccounts();
    expect(accounts[0]).toMatchObject({
      accountRef: result.accountRef,
      status: "connected",
      planEnabled: true,
      planWelcomeAcknowledged: false,
    });
    expect(JSON.stringify([accounts, result])).not.toMatch(
      /ACCESS|REFRESH|id_token|clientId|subject|nonce|verifier/,
    );
    const tokenCall = f.calls.find((call) =>
      call.url.endsWith("/oauth/token"),
    )!;
    const values = new URLSearchParams(String(tokenCall.init?.body));
    expect(values.get("client_id")).toBe("oaiapp_fixture");
    expect(values.get("redirect_uri")).toBe(
      started.url.searchParams.get("redirect_uri"),
    );
    expect(values.get("code_verifier")).toBeTruthy();
    expect(tokenCall.init?.redirect).toBe("error");
    await expect(
      started.consume(
        new URLSearchParams({
          state: started.url.searchParams.get("state")!,
          code: "again",
        }),
      ),
    ).rejects.toMatchObject({ code: "chatgpt_attempt_expired" });
    expect(
      JSON.parse(await readFile(join(f.directory, "accounts.json"), "utf8"))
        .accounts,
    ).toHaveLength(1);
  });
  it("reuses host/client identity and requires the selected identity before replacing credentials", async () => {
    const f = await fixture();
    const accountRef = await f.signIn();
    const started = await f.begin(accountRef);
    expect(started.url.searchParams.get("client_id")).toBe("oaiapp_fixture");
    expect(started.url.searchParams.has("agent_name_hint")).toBe(false);
    f.subject("other-subject");
    await expect(
      started.consume(
        new URLSearchParams({
          state: started.url.searchParams.get("state")!,
          code: "code",
        }),
      ),
    ).rejects.toMatchObject({ code: "chatgpt_account_mismatch" });
    expect(await f.service.getAccessToken(accountRef)).toBe("ACCESS-0");
    const consent = await f.begin(accountRef, "enable_plan_usage");
    expect(consent.url.searchParams.get("prompt")).toBe("consent");
  });
  it("retains identity-only sign-in, blocks inference and records welcome once after consent", async () => {
    const f = await fixture();
    f.scopes("openid profile email");
    const accountRef = await f.signIn();
    expect((await f.service.listAccounts())[0]).toMatchObject({
      status: "identity_only",
      planEnabled: false,
    });
    await expect(f.service.getAccessToken(accountRef)).rejects.toMatchObject({
      code: "chatgpt_plan_required",
    });
    f.scopes("openid resource.invoke chatgpt.tokens.use.direct offline_access");
    await f.signIn(accountRef);
    await f.service.acknowledgePlan(accountRef);
    expect((await f.service.listAccounts())[0]?.planWelcomeAcknowledged).toBe(
      true,
    );
    await f.service.disconnect(accountRef);
    await f.signIn(accountRef);
    expect((await f.service.listAccounts())[0]?.planWelcomeAcknowledged).toBe(
      true,
    );
  });
  it("handles declined, cancelled, expired and mismatched-client callbacks without token exchange", async () => {
    const f = await fixture();
    const denied = await f.begin();
    await expect(
      denied.consume(
        new URLSearchParams({
          state: denied.url.searchParams.get("state")!,
          error: "access_denied",
          error_description: "SECRET",
        }),
      ),
    ).rejects.toMatchObject({ code: "chatgpt_access_denied" });
    expect(
      JSON.stringify(f.service.getAttempt(denied.attempt.attemptId)),
    ).not.toContain("SECRET");
    const cancelled = await f.begin();
    f.service.cancelAttempt(cancelled.attempt.attemptId);
    await expect(
      cancelled.consume(
        new URLSearchParams({
          state: cancelled.url.searchParams.get("state")!,
          code: "code",
        }),
      ),
    ).rejects.toMatchObject({ code: "chatgpt_attempt_expired" });
    const expired = await f.begin();
    f.advance(600001);
    expect(f.service.getAttempt(expired.attempt.attemptId).status).toBe(
      "cancelled",
    );
    expect(f.calls.some((call) => call.url.endsWith("/oauth/token"))).toBe(
      false,
    );
    const ref = await f.signIn();
    const mismatch = await f.begin(ref);
    const before = f.calls.length;
    await expect(
      mismatch.consume(
        new URLSearchParams({
          state: mismatch.url.searchParams.get("state")!,
          code: "code",
          client_id: "oaiapp_other",
        }),
      ),
    ).rejects.toMatchObject({ code: "chatgpt_account_mismatch" });
    expect(f.calls).toHaveLength(before);
  });
});
