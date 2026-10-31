import { describe, expect, it } from "vitest";
import { ChatGptAuthService } from "../service.js";
import { authFixture } from "./fixture.js";

describe("disconnect invalidates asynchronous sign-in preparation", () => {
  it.each([
    "discovery",
    "callback",
    "other-discovery",
    "other-callback",
  ] as const)(
    "does not publish an attempt after disconnect during %s",
    async (mode) => {
      const phase = mode.endsWith("discovery") ? "discovery" : "callback";
      const f = await authFixture();
      const accountRef = await f.signIn();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let shouldHoldDiscovery = phase === "discovery";
      let callbackClosed = false;
      const service = new ChatGptAuthService({
        ...f.options,
        fetchImpl: (async (input, init) => {
          if (
            shouldHoldDiscovery &&
            String(input).endsWith("openid-configuration")
          ) {
            shouldHoldDiscovery = false;
            entered();
            await held;
          }
          return f.fetchImpl(input, init);
        }) as typeof fetch,
        callbackFactory: async () => {
          if (phase === "callback") {
            entered();
            await held;
          }
          return {
            redirectUri: "http://127.0.0.1:32123/auth/callback",
            close() {
              callbackClosed = true;
            },
          };
        },
      });
      try {
        const beginning = service.beginAttempt({ accountRef });
        const rejected = expect(beginning).rejects.toMatchObject({
          code: "chatgpt_attempt_cancelled",
        });
        await entering;
        expect(
          await (mode.startsWith("other-") ? f.service : service).disconnect(
            accountRef,
          ),
        ).toMatchObject({
          revocationConfirmed: true,
        });
        release();
        await rejected;
        expect((await service.listAccounts())[0]?.status).toBe("signed_out");
        if (phase === "callback") expect(callbackClosed).toBe(true);
      } finally {
        release();
        service.close();
        f.service.close();
      }
    },
  );
  it("rejects an already published callback after another process disconnects its account", async () => {
    const f = await authFixture();
    const accountRef = await f.signIn();
    const started = await f.begin(accountRef);
    const other = new ChatGptAuthService(f.options);
    try {
      await other.disconnect(accountRef);
      const before = f.calls.filter((call) =>
        call.url.endsWith("/oauth/token"),
      ).length;
      await expect(
        started.consume(
          new URLSearchParams({
            state: started.url.searchParams.get("state")!,
            code: "code",
            client_id: "oaiapp_fixture",
          }),
        ),
      ).rejects.toMatchObject({ code: "chatgpt_attempt_cancelled" });
      expect(
        f.calls.filter((call) => call.url.endsWith("/oauth/token")),
      ).toHaveLength(before);
      expect((await f.service.listAccounts())[0]?.status).toBe("signed_out");
    } finally {
      other.close();
      f.service.close();
    }
  });
});
