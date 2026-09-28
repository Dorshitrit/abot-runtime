import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import type { NotificationPage } from "../../web-ui/notifications/contracts.js";

const boundary = vi.hoisted(() => ({
  publish: undefined as ((event: Record<string, unknown>) => void) | undefined,
  replays: new Map<string, Record<string, unknown>>(),
  executeHostOperation: vi.fn(),
}));

// Stand in for the Runtime owner only. The Web backend's publisher, realtime
// controller, notification service, persistence, and HTTP routes remain real.
vi.mock("../../web-ui/local-runtime/environment-registry.js", () => ({
  RuntimeEnvironmentRegistry: class {
    constructor(
      private readonly options: { rootDir: string },
      bindings: { publish?: (event: Record<string, unknown>) => void },
    ) {
      boundary.publish = bindings.publish;
    }
    environmentConfig() {
      return {
        defaultEnvironmentId: "dev",
        environments: [{ id: "dev" }, { id: "prod" }],
      };
    }
    get(id: string) {
      if (!["dev", "prod"].includes(id))
        throw new Error("Unknown fixture environment");
      return {
        services: {
          config: {
            paths: {
              runtimeDir: `${this.options.rootDir}/${id}/runtime`,
              sessionsDir: `${this.options.rootDir}/${id}/sessions`,
            },
          },
          sessions: {
            getRequestReplayById: async (requestId: string) =>
              boundary.replays.get(`${id}:${requestId}`) ?? null,
          },
        },
      };
    }
    async stop() {}
  },
}));

vi.mock("../../computer-access/companion/broker-client.js", () => ({
  readHostStatus: vi.fn(async () => ({ paired: false, connected: false })),
  executeHostOperation: boundary.executeHostOperation,
}));

const { LocalRuntimeWebBackend } =
  await import("../../web-ui/local-runtime-backend.js");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  boundary.replays.clear();
  boundary.publish = undefined;
  expect(boundary.executeHostOperation).not.toHaveBeenCalled();
  boundary.executeHostOperation.mockClear();
});

function completed(
  requestId: string,
  environment = "dev",
  sessionId = "conversation",
) {
  return {
    type: "completed",
    requestId,
    environment,
    sessionId,
    output: `Result for ${requestId}`,
  };
}

function realtimeClient() {
  const sent: Record<string, unknown>[] = [];
  const client = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload)),
  });
  return {
    client: client as unknown as WebSocket,
    sent,
    setReadyState: (state: number) => {
      client.readyState = state;
    },
    message: (value: Record<string, unknown>) =>
      client.emit("message", Buffer.from(JSON.stringify(value))),
  };
}

async function fixture() {
  const artifacts = join(
    process.cwd(),
    ".codex/artifacts/notifications-20260927",
  );
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "backend-test-"));
  const createBackend = () =>
    new LocalRuntimeWebBackend({ rootDir, defaultEnvironmentId: "dev" });
  let backend = createBackend();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    void backend.handleHttp(request, response, pathname).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    await backend.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(rootDir, { recursive: true, force: true });
  });
  const request = async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(
      origin + path,
      body
        ? {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify(body),
          }
        : undefined,
    );
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result;
  };
  return {
    inbox: (environment = "dev"): Promise<NotificationPage> =>
      request(`/web-api/notifications?environment=${environment}`),
    read: (id: string) =>
      request("/web-api/notifications/read", {
        environment: "dev",
        ids: [id],
        read: true,
      }),
    publish: (event: Record<string, unknown>) => boundary.publish!(event),
    connect: (client: WebSocket) => backend.handleRealtimeConnection(client),
    async restart() {
      await backend.stop();
      backend = createBackend();
    },
  };
}

test("a Runtime completion without any browser persists through HTTP and backend recreation", async () => {
  const f = await fixture();
  f.publish(completed("background-result"));
  await expect
    .poll(async () => (await f.inbox()).items[0]?.delivery.status)
    .toBe("unavailable");
  const page = await f.inbox();
  expect(page).toMatchObject({
    unreadCount: 1,
    items: [
      {
        kind: "reply",
        environmentId: "dev",
        sessionId: "conversation",
        requestId: "background-result",
        body: "Result for background-result",
        sourceUrl: "/chat?environment=dev&session=conversation",
      },
    ],
  });
  await f.read(page.items[0].id);
  await f.restart();
  f.publish(completed("background-result"));
  f.publish(completed("later-result"));
  await expect.poll(async () => (await f.inbox()).items.length).toBe(2);
  const restored = await f.inbox();
  expect(restored.unreadCount).toBe(1);
  expect(
    restored.items.find((item) => item.id === page.items[0].id)?.readAt,
  ).toBeTypeOf("number");
  expect((await f.inbox("prod")).items).toEqual([]);
});

test("actual realtime presence suppresses only the focused environment and conversation", async () => {
  const f = await fixture();
  const browser = realtimeClient();
  f.connect(browser.client);
  browser.message({
    type: "notification_presence",
    environment: "dev",
    sessionId: "conversation",
    active: true,
  });
  f.publish(completed("focused"));
  f.publish(completed("other-conversation", "dev", "other"));
  f.publish(completed("same-session-other-environment", "prod"));
  await expect.poll(async () => (await f.inbox("prod")).items.length).toBe(1);
  expect((await f.inbox()).items.map((item) => item.requestId)).toEqual([
    "other-conversation",
  ]);
  expect(browser.sent.some((event) => event.requestId === "focused")).toBe(
    true,
  );
  browser.client.emit("close");
  f.publish(completed("after-browser-closed"));
  await expect.poll(async () => (await f.inbox()).items.length).toBe(2);
  expect(
    (await f.inbox()).items.some(
      (item) => item.requestId === "after-browser-closed",
    ),
  ).toBe(true);
});

test.each([2, 3])(
  "socket state %i cannot suppress replies before its close event arrives",
  async (readyState) => {
    const f = await fixture();
    const closingBrowser = realtimeClient();
    const openBrowser = realtimeClient();
    const presence = {
      type: "notification_presence",
      environment: "dev",
      sessionId: "conversation",
      active: true,
    };
    for (const browser of [closingBrowser, openBrowser]) {
      f.connect(browser.client);
      browser.message(presence);
    }
    closingBrowser.setReadyState(readyState);
    f.publish(completed("still-viewed-by-open-browser"));
    expect((await f.inbox()).items).toEqual([]);
    expect(
      openBrowser.sent.some(
        (event) => event.requestId === "still-viewed-by-open-browser",
      ),
    ).toBe(true);

    // A buffered message can still arrive while the closing handshake runs.
    closingBrowser.message(presence);
    openBrowser.message({ ...presence, active: false });
    f.publish(completed("closing-browser-misses-reply"));
    await expect.poll(async () => (await f.inbox()).items.length).toBe(1);
    expect((await f.inbox()).items[0].requestId).toBe(
      "closing-browser-misses-reply",
    );
    expect(
      closingBrowser.sent.some((event) => event.type === "completed"),
    ).toBe(false);
    expect(
      openBrowser.sent.some(
        (event) => event.requestId === "closing-browser-misses-reply",
      ),
    ).toBe(true);
  },
);

test("resuming stored request events sends a terminal reply to the browser without creating inbox history", async () => {
  const f = await fixture();
  const browser = realtimeClient();
  f.connect(browser.client);
  boundary.replays.set("dev:old-request", {
    sessionId: "conversation",
    events: [completed("old-request")],
    finalState: {
      status: "completed",
      output: "A reply from before notification tracking",
    },
  });
  browser.message({
    type: "resume_request",
    environment: "dev",
    requestId: "old-request",
    afterSeq: 0,
  });
  await expect
    .poll(
      () =>
        browser.sent.filter((event) => event.requestId === "old-request")
          .length,
    )
    .toBe(2);
  f.publish(completed("new-request"));
  await expect.poll(async () => (await f.inbox()).items.length).toBe(1);
  expect((await f.inbox()).items.map((item) => item.requestId)).toEqual([
    "new-request",
  ]);
});
