import { describe, expect, it, vi } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { ChatGptAuthRoutes } from "./routes.js";
import type { ChatGptAuthService } from "../../provider-auth/chatgpt/service.js";

describe("local-only ChatGPT management routes", () => {
  it("requires local same-origin authority for account reads and JSON for mutations", async () => {
    const service = {
      listAccounts: vi.fn(async () => []),
      beginAttempt: vi.fn(async () => ({
        attemptId: "opaque",
        status: "pending",
      })),
    } as unknown as ChatGptAuthService;
    const routes = new ChatGptAuthRoutes(service);
    const server = createServer(async (request, response) => {
      await routes.handle(
        new URL(request.url!, "http://localhost").pathname.slice(1),
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
    try {
      const accounts = await fetch(origin + "/runtime/chatgpt/accounts");
      expect(accounts.status).toBe(200);
      expect(await accounts.json()).toEqual({ ok: true, accounts: [] });
      expect(accounts.headers.get("cache-control")).toBe("private, no-store");
      expect(
        (
          await fetch(origin + "/runtime/chatgpt/accounts", {
            headers: { origin: "https://evil.example" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(origin + "/runtime/chatgpt/attempts", {
            method: "POST",
            headers: { origin },
            body: "{}",
          })
        ).status,
      ).toBe(415);
      const started = await fetch(origin + "/runtime/chatgpt/attempts", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: '{"purpose":"sign_in"}',
      });
      expect(started.status).toBe(200);
      expect(service.beginAttempt).toHaveBeenCalledWith({ purpose: "sign_in" }, undefined);
      expect(
        (
          await fetch(origin + "/runtime/chatgpt/attempts", {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: '{"redirect_uri":"https://evil.example"}',
          })
        ).status,
      ).toBe(400);
      expect(service.beginAttempt).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
  it("rejects a remote client even with a forged localhost Host header", async () => {
    const service = { listAccounts: vi.fn() } as unknown as ChatGptAuthService;
    const routes = new ChatGptAuthRoutes(service);
    const request = {
      method: "GET",
      headers: { host: "127.0.0.1:5000" },
      socket: {
        remoteAddress: "192.0.2.1",
        localAddress: "127.0.0.1",
        localPort: 5000,
      },
    } as IncomingMessage;
    let status = 0;
    const response = {
      setHeader() {},
      once() {},
      removeListener() {},
      writeHead(code: number) {
        status = code;
      },
      end() {},
    } as unknown as ServerResponse;
    expect(
      await routes.handle("runtime/chatgpt/accounts", request, response),
    ).toBe(true);
    expect(status).toBe(403);
    expect(service.listAccounts).not.toHaveBeenCalled();
  });
});
