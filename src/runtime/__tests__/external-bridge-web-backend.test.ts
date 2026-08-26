import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { ExternalBridgeWebBackend } from "../../web-ui/external-bridge-backend.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

describe("external bridge web backend", () => {
  let upstream: Server | undefined;
  let proxy: Server | undefined;

  afterEach(async () => {
    if (proxy) {
      await closeServer(proxy);
      proxy = undefined;
    }
    if (upstream) {
      await closeServer(upstream);
      upstream = undefined;
    }
  });

  test("proxies web-api requests through the external bridge contract", async () => {
    const received: Array<{
      path: string;
      token: string;
      body: Record<string, unknown>;
    }> = [];
    upstream = createServer((req, res) => {
      void (async () => {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        received.push({
          path: req.url || "",
          token: String(req.headers["x-chat-api-token"] || ""),
          body,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, requestId: "req-1" }));
      })();
    });
    const upstreamPort = await listen(upstream);
    const backend = new ExternalBridgeWebBackend({
      apiBaseUrl: `http://127.0.0.1:${upstreamPort}/bridge/api`,
      realtimeUrl: `ws://127.0.0.1:${upstreamPort}/bridge/realtime`,
      healthUrl: `http://127.0.0.1:${upstreamPort}/bridge/health`,
      agentModeUrl: `http://127.0.0.1:${upstreamPort}/bridge/agent-mode`,
      assistantHostUrl: `http://127.0.0.1:${upstreamPort}`,
      apiToken: "secret-token",
    });
    proxy = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    const proxyPort = await listen(proxy);

    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/web-api/chat/messages?environment=dev`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "hello",
          sessionId: "session-1",
          environment: "dev",
        }),
      },
    );
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.ok).toBe(true);
    expect(payload).toMatchObject({ ok: true, requestId: "req-1" });
    expect(received).toEqual([
      {
        path: "/bridge/api/chat/messages?environment=dev&agentId=dev",
        token: "secret-token",
        body: {
          text: "hello",
          sessionId: "session-1",
          environment: "dev",
          agentId: "dev",
        },
      },
    ]);
  });

  test("normalizes legacy bridge model catalogs to the Web availability contract", async () => {
    upstream = createServer((req, res) => {
      const requestUrl = new URL(req.url || "/", "http://localhost");
      const catalogCase = requestUrl.searchParams.get("catalog");
      const payload =
        catalogCase === "empty"
          ? { ok: true, defaultProfileId: "", profiles: [] }
          : catalogCase === "current"
            ? {
                ok: true,
                defaultProfileId: "",
                profiles: [],
                availability: {
                  status: "setup_required",
                  code: "bridge_setup_required",
                  message: "Configure the bridge host.",
                },
              }
            : {
                ok: true,
                defaultProfileId: "model-1",
                profiles: [{ id: "model-1", model: "test:model" }],
              };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    const upstreamPort = await listen(upstream);
    const backend = new ExternalBridgeWebBackend({
      apiBaseUrl: `http://127.0.0.1:${upstreamPort}/bridge/api`,
      realtimeUrl: `ws://127.0.0.1:${upstreamPort}/bridge/realtime`,
      healthUrl: `http://127.0.0.1:${upstreamPort}/bridge/health`,
      agentModeUrl: `http://127.0.0.1:${upstreamPort}/bridge/agent-mode`,
      assistantHostUrl: `http://127.0.0.1:${upstreamPort}`,
      apiToken: "",
    });
    proxy = createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      void backend.handleHttp(req, res, pathname);
    });
    const proxyPort = await listen(proxy);

    const ready = await fetch(
      `http://127.0.0.1:${proxyPort}/web-api/chat/models?catalog=ready`,
    ).then((response) => response.json());
    const empty = await fetch(
      `http://127.0.0.1:${proxyPort}/web-api/chat/models?catalog=empty`,
    ).then((response) => response.json());
    const current = await fetch(
      `http://127.0.0.1:${proxyPort}/web-api/chat/models?catalog=current`,
    ).then((response) => response.json());

    expect(ready).toMatchObject({ availability: { status: "ready" } });
    expect(empty).toMatchObject({
      availability: {
        status: "setup_required",
        code: "runtime_configuration_required",
      },
    });
    expect(current).toMatchObject({
      availability: {
        status: "setup_required",
        code: "bridge_setup_required",
        message: "Configure the bridge host.",
      },
    });
  });
});
