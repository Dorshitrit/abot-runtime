import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { ChatGptAuthService } from "../service.js";
import { authFixture } from "./fixture.js";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const fixtures: Awaited<ReturnType<typeof authFixture>>[] = [];
async function fixture() {
  const value = await authFixture();
  fixtures.push(value);
  return value;
}
afterEach(() => {
  vi.mocked(fs.rename).mockRestore();
  for (const value of fixtures.splice(0)) value.service.close();
});
describe("ChatGPT attempt lifecycle barriers", () => {
  it("retries an invalid code using the retained registration with fresh PKCE and host identity", async () => {
    const f = await fixture();
    const initial = await f.begin();
    f.tokenError("invalid_grant");
    await expect(
      initial.consume(
        new URLSearchParams({
          state: initial.url.searchParams.get("state")!,
          code: "old",
          client_id: "oaiapp_fixture",
        }),
      ),
    ).rejects.toMatchObject({ code: "chatgpt_reauth_required" });
    expect(await f.service.listAccounts()).toEqual([]);
    expect(f.service.getAttempt(initial.attempt.attemptId).retryable).toBe(
      true,
    );
    const retry = await f.service.retryAttempt(initial.attempt.attemptId);
    const url = new URL(retry.authorizationUrl!);
    expect(url.searchParams.get("client_id")).toBe("oaiapp_fixture");
    expect(url.searchParams.get("ext_agent_host_id")).toBe(
      initial.url.searchParams.get("ext_agent_host_id"),
    );
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
    for (const field of ["nonce", "state", "code_challenge"])
      expect(url.searchParams.get(field)).not.toBe(
        initial.url.searchParams.get(field),
      );
    expect(f.service.getAttempt(initial.attempt.attemptId).retryable).toBe(
      false,
    );
  });
  it("rejects multibyte forged state without consuming the real attempt", async () => {
    const f = await fixture();
    const started = await f.begin();
    const state = started.url.searchParams.get("state")!;
    await expect(
      started.consume(
        new URLSearchParams({ state: "é".repeat(state.length), code: "code" }),
      ),
    ).rejects.toMatchObject({ code: "chatgpt_state_invalid" });
    expect(f.service.getAttempt(started.attempt.attemptId).status).toBe(
      "pending",
    );
  });
  it("does not publish credentials when cancelled before the publication barrier", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let consume!: (parameters: URLSearchParams) => Promise<void>;
    const service = new ChatGptAuthService({
      ...f.options,
      fetchImpl: (async (input, init) => {
        if (String(input).endsWith("/oauth/token")) {
          entered();
          await held;
        }
        return f.fetchImpl(input, init);
      }) as typeof fetch,
      callbackFactory: async (callback) => {
        consume = callback;
        return {
          redirectUri: "http://127.0.0.1:32123/auth/callback",
          close() {},
        };
      },
    });
    const attempt = await service.beginAttempt();
    const url = new URL(attempt.authorizationUrl!);
    const finishing = consume(
      new URLSearchParams({
        state: url.searchParams.get("state")!,
        code: "code",
        client_id: "oaiapp_fixture",
      }),
    ).catch(() => undefined);
    await entering;
    expect(service.cancelAttempt(attempt.attemptId).status).toBe("cancelled");
    release();
    await finishing;
    expect(await service.listAccounts()).toEqual([]);
    expect(service.getAttempt(attempt.attemptId).status).toBe("cancelled");
    service.close();
  });
  it("cannot report cancellation once validated credentials are being atomically published", async () => {
    const f = await fixture();
    const started = await f.begin();
    const original = vi.mocked(fs.rename).getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      if (String(args[1]).endsWith("accounts.json")) {
        entered();
        await held;
      }
      return original(...args);
    });
    const finishing = started.consume(
      new URLSearchParams({
        state: started.url.searchParams.get("state")!,
        code: "code",
        client_id: "oaiapp_fixture",
      }),
    );
    await entering;
    expect(() => f.service.cancelAttempt(started.attempt.attemptId)).toThrow(
      expect.objectContaining({ code: "chatgpt_attempt_completing" }),
    );
    release();
    await finishing;
    expect(f.service.getAttempt(started.attempt.attemptId).status).toBe(
      "complete",
    );
    expect(await f.service.listAccounts()).toHaveLength(1);
    expect(
      await fs.readFile(join(f.directory, "accounts.json"), "utf8"),
    ).toContain("REFRESH");
  });
});
