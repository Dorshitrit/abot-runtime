import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { ChatGptAuthService } from "../../provider-auth/chatgpt/service.js";
import { CHATGPT_ISSUER } from "../../provider-auth/chatgpt/contracts.js";
import { ChatGptAuthRoutes } from "../../web-ui/chatgpt-auth/routes.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

describe("ChatGPT cancellation through the browser transport", () => {
  test("sends JSON through the real mutation guard and cancels the callback", async () => {
    const artifacts = resolve(".codex/artifacts/siwc-review-320/cancellation");
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(join(artifacts, "account-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    let callback: ((parameters: URLSearchParams) => Promise<void>) | undefined;
    const closeCallback = vi.fn();
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        CHATGPT_ISSUER + "/.well-known/openid-configuration",
      );
      return Response.json({
        issuer: CHATGPT_ISSUER,
        jwks_uri: CHATGPT_ISSUER + "/jwks",
        revocation_endpoint: CHATGPT_ISSUER + "/revoke",
      });
    });
    const service = new ChatGptAuthService({
      directory,
      fetchImpl: providerFetch as typeof fetch,
      callbackFactory: async (consume) => {
        callback = consume;
        return {
          redirectUri: "http://127.0.0.1:32123/auth/callback",
          close: closeCallback,
        };
      },
    });
    const routes = new ChatGptAuthRoutes(service);
    const requests: Array<{
      method: string | undefined;
      contentType: string | undefined;
    }> = [];
    const server = createServer(async (request, response) => {
      requests.push({
        method: request.method,
        contentType: request.headers["content-type"],
      });
      await routes.handle(
        new URL(request.url!, "http://localhost").pathname.slice(
          "/web-api/".length,
        ),
        request,
        response,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture_listener");
    const origin = "http://127.0.0.1:" + address.port;
    const client = createRuntimeWebClient({
      getConfig: () => ({ backend: "runtime" }),
      getEnvironmentId: () => "dev",
      origin,
      fetchImpl: (input, init) =>
        fetch(new URL(String(input), origin), {
          ...init,
          headers: { ...init?.headers, origin },
        }),
    });
    try {
      const started = await service.beginAttempt();
      const state = new URL(started.authorizationUrl!).searchParams.get(
        "state",
      )!;
      await expect(
        client.cancelChatgptAttempt(started.attemptId),
      ).resolves.toMatchObject({
        ok: true,
        attempt: { attemptId: started.attemptId, status: "cancelled" },
      });
      expect(requests).toEqual([
        { method: "DELETE", contentType: "application/json" },
      ]);
      expect(service.getAttempt(started.attemptId).status).toBe("cancelled");
      expect(closeCallback).toHaveBeenCalledOnce();
      expect(callback).toBeDefined();
      await expect(
        callback!(
          new URLSearchParams({
            state,
            code: "unused-fixture-code",
            client_id: "oaiapp_fixture",
          }),
        ),
      ).rejects.toMatchObject({ code: "chatgpt_attempt_expired" });
      expect(providerFetch).toHaveBeenCalledOnce();
      expect(await service.listAccounts()).toEqual([]);
    } finally {
      service.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
});
