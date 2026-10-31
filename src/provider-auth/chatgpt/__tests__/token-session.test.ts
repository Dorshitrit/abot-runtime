import { afterEach, describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ChatGptAuthService } from "../service.js";
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
describe("ChatGPT rotating token sessions", () => {
  it("serializes refresh across service instances and persists replacement before returning", async () => {
    const f = await fixture();
    const ref = await f.signIn();
    const second = new ChatGptAuthService(f.options);
    f.advance(3590000);
    expect(
      await Promise.all([
        f.service.getAccessToken(ref),
        second.getAccessToken(ref),
        f.service.getAccessToken(ref),
      ]),
    ).toEqual(["ACCESS-1", "ACCESS-1", "ACCESS-1"]);
    expect(f.refreshes()).toBe(1);
    const saved = JSON.parse(
      await readFile(join(f.directory, "accounts.json"), "utf8"),
    );
    expect(saved.accounts[0].tokens.refreshToken).toBe("REFRESH-1");
    expect((await stat(join(f.directory, "accounts.json"))).mode & 0o077).toBe(
      0,
    );
    second.close();
  });
  it("clears credentials on invalid grant and disconnect without losing registration", async () => {
    const f = await fixture();
    const ref = await f.signIn();
    f.advance(3600000);
    f.tokenError("invalid_grant");
    await expect(f.service.getAccessToken(ref)).rejects.toMatchObject({
      code: "chatgpt_reauth_required",
    });
    expect((await f.service.listAccounts())[0]?.status).toBe("reauth_required");
    f.tokenError(undefined);
    await f.signIn(ref);
    const result = await f.service.disconnect(ref);
    expect(result.revocationConfirmed).toBe(true);
    await expect(f.service.getAccessToken(ref)).rejects.toMatchObject({
      code: "chatgpt_reauth_required",
    });
    expect((await f.service.listAccounts())[0]?.status).toBe("signed_out");
    const saved = JSON.parse(
      await readFile(join(f.directory, "accounts.json"), "utf8"),
    );
    expect(saved.accounts[0].clientId).toBe("oaiapp_fixture");
    expect(saved.accounts[0].tokens).toBeUndefined();
  });
  it("signs out locally even when remote revocation is unconfirmed", async () => {
    const f = await fixture();
    const ref = await f.signIn();
    f.revokeFails();
    expect(await f.service.disconnect(ref)).toMatchObject({
      revocationConfirmed: false,
      message: expect.stringContaining("not confirmed"),
    });
    await expect(f.service.getAccessToken(ref)).rejects.toMatchObject({
      code: "chatgpt_reauth_required",
    });
  });
  it("lists only displayable account models in server order and does no HTTP for account summaries", async () => {
    const f = await fixture();
    expect(await f.service.listAccounts()).toEqual([]);
    expect(f.calls).toHaveLength(0);
    const ref = await f.signIn();
    const before = f.calls.length;
    await f.service.listAccounts();
    expect(f.calls).toHaveLength(before);
    expect(await f.service.listModels(ref)).toEqual([
      { id: "visible-b", displayName: "Visible B", contextWindow: 20000 },
      { id: "visible-a", displayName: "Visible A" },
    ]);
    const request = f.calls.find((entry) => entry.url.endsWith("/models"))!;
    expect(request.url).toBe("https://api.openai.com/v1/models");
    expect(request.init?.headers).toMatchObject({
      authorization: "Bearer ACCESS-0",
    });
  });
});
