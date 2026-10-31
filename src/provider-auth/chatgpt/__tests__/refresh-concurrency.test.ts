import { describe, expect, it } from "vitest";
import { ChatGptAuthService } from "../service.js";
import { authFixture } from "./fixture.js";

describe("serialized ChatGPT refresh and disconnect", () => {
  it("revokes the latest persisted replacement after a held refresh and blocks later requests", async () => {
    const f = await authFixture();
    const ref = await f.signIn();
    f.advance(3590000);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = new ChatGptAuthService({
      ...f.options,
      fetchImpl: (async (input, init) => {
        const form = new URLSearchParams(String(init?.body));
        if (
          String(input).endsWith("/oauth/token") &&
          form.get("grant_type") === "refresh_token"
        ) {
          entered();
          await held;
        }
        return f.fetchImpl(input, init);
      }) as typeof fetch,
    });
    const other = new ChatGptAuthService(f.options);
    try {
      const access = service.getAccessToken(ref);
      await entering;
      const disconnected = other.disconnect(ref);
      release();
      expect(await access).toBe("ACCESS-1");
      expect(await disconnected).toMatchObject({ revocationConfirmed: true });
      const revoke = f.calls.find((call) =>
        call.url.endsWith("/oauth/revoke"),
      )!;
      expect(new URLSearchParams(String(revoke.init?.body)).get("token")).toBe(
        "REFRESH-1",
      );
      await expect(service.getAccessToken(ref)).rejects.toMatchObject({
        code: "chatgpt_reauth_required",
      });
      expect(f.refreshes()).toBe(1);
    } finally {
      release();
      service.close();
      other.close();
      f.service.close();
    }
  });
});
