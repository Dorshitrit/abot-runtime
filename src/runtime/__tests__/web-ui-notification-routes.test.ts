import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultNotificationPreferences } from "../../web-ui/notifications/contracts.js";
import {
  WebNotificationRoutes,
  type WebNotificationAccess,
} from "../../web-ui/notifications/routes.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

async function fixture() {
  const access: WebNotificationAccess = {
    hasEnvironment: vi.fn((id: string) => id === "dev"),
    list: vi.fn(async () => ({
      items: [],
      unreadCount: 0,
      nextCursor: null,
      preferences: defaultNotificationPreferences(),
    })),
    desktop: vi.fn(() => ({
      available: false,
      message: "Connect Computer access",
    })),
    markRead: vi.fn(async () => ({ updated: 1, unreadCount: 0 })),
    setPreferences: vi.fn(async (_id, preferences) => preferences),
  };
  const routes = new WebNotificationRoutes(access);
  const server = createServer(async (request, response) => {
    if (await routes.handle(request, response)) return;
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    access,
    origin,
    request: (path: string, init?: RequestInit) => fetch(origin + path, init),
  };
}

describe("Web UI notification HTTP routes", () => {
  test("returns bounded history, preferences, and desktop availability for an explicit environment", async () => {
    const { request, access } = await fixture();
    const response = await request(
      "/web-api/notifications?environment=dev&limit=100",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      items: [],
      unreadCount: 0,
      nextCursor: null,
      desktop: { available: false },
      preferences: { desktopEnabled: true },
    });
    expect(access.list).toHaveBeenCalledWith("dev", {
      limit: 100,
      before: undefined,
    });
  });

  test("rejects malformed and ambiguous queries before touching storage", async () => {
    const { request, access } = await fixture();
    for (const query of [
      "",
      "environment=dev&limit=101",
      "environment=dev&limit=1.5",
      "environment=dev&limit=1e2",
      "environment=dev&limit=0",
      "environment=dev&environment=prod",
      "environment=dev&extra=value",
    ]) {
      expect((await request(`/web-api/notifications?${query}`)).status).toBe(
        400,
      );
    }
    expect(
      (await request("/web-api/notifications?environment=missing")).status,
    ).toBe(404);
    expect(access.list).not.toHaveBeenCalled();
  });

  test("enforces exact browser origin and JSON content type for all writes", async () => {
    const { request, origin, access } = await fixture();
    const body = JSON.stringify({ environment: "dev", ids: ["a"], read: true });
    const rejectedOrigins: Record<string, string>[] = [
      { "content-type": "application/json", origin: "https://other.test" },
      {
        "content-type": "application/json",
        origin: origin.replace("127.0.0.1", "localhost"),
      },
      {
        "content-type": "application/json",
        origin,
        "sec-fetch-site": "cross-site",
      },
    ];
    for (const headers of rejectedOrigins)
      expect(
        (
          await request("/web-api/notifications/read", {
            method: "POST",
            headers,
            body,
          })
        ).status,
      ).toBe(403);
    expect(
      (
        await request("/web-api/notifications/read", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        })
      ).status,
    ).toBe(415);
    expect(access.markRead).not.toHaveBeenCalled();
    const accepted = await request("/web-api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(access.markRead).toHaveBeenCalledWith("dev", {
      ids: ["a"],
      read: true,
    });
    expect(
      (
        await request("/web-api/notifications/read?environment=prod", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body,
        })
      ).status,
    ).toBe(400);
    expect(access.markRead).toHaveBeenCalledTimes(1);
  });

  test("supports unread selection and read all while rejecting broad or incomplete mutations", async () => {
    const { request, access } = await fixture();
    const post = (value: unknown) =>
      request("/web-api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    expect(
      (await post({ environment: "dev", all: true, read: true })).status,
    ).toBe(200);
    expect(
      (await post({ environment: "dev", ids: ["a", "a"], read: false })).status,
    ).toBe(200);
    expect(access.markRead).toHaveBeenLastCalledWith("dev", {
      ids: ["a"],
      read: false,
    });
    for (const value of [
      null,
      [],
      {},
      { environment: "dev", all: true, read: false },
      { environment: "dev", ids: [], read: true },
      { environment: "dev", ids: [3], read: true },
      { environment: "dev", all: true, ids: ["a"], read: true },
      { environment: "dev", ids: ["a"], read: true, extra: true },
    ])
      expect((await post(value)).status).toBe(400);
    expect(
      (await post({ environment: "missing", all: true, read: true })).status,
    ).toBe(404);
    expect(access.markRead).toHaveBeenCalledTimes(2);
  });

  test("persists a complete preference update and rejects oversized JSON", async () => {
    const { request, access } = await fixture();
    const preferences = {
      ...defaultNotificationPreferences(),
      desktopEnabled: false,
    };
    const put = (value: unknown) =>
      request("/web-api/notifications/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    expect((await put({ environment: "dev", ...preferences })).status).toBe(
      200,
    );
    expect(access.setPreferences).toHaveBeenCalledWith("dev", preferences);
    expect(
      (await put({ environment: "dev", desktopEnabled: false })).status,
    ).toBe(400);
    expect(
      (
        await put({
          environment: "dev",
          ...preferences,
          extra: "x".repeat(65536),
        })
      ).status,
    ).toBe(400);
    expect(access.setPreferences).toHaveBeenCalledTimes(1);
  });

  test("reports unavailable storage and handles unknown paths and unsupported methods", async () => {
    const { request, access } = await fixture();
    vi.mocked(access.list).mockRejectedValue(
      new Error("secret filesystem path"),
    );
    const response = await request("/web-api/notifications?environment=dev");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret filesystem path");
    expect(
      (await request("/web-api/notifications", { method: "DELETE" })).status,
    ).toBe(405);
    expect((await request("/web-api/other")).status).toBe(404);
  });
});
