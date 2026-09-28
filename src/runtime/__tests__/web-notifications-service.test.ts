import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type { RuntimeConfig } from "../ports.js";
import { WebNotificationService } from "../../web-ui/notifications/service.js";
import { NotificationPresence } from "../../web-ui/notifications/presence.js";
import { projectNotificationEvent } from "../../web-ui/notifications/event-projection.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";
import {
  notificationStorePath,
  WebNotificationStore,
} from "../../web-ui/notifications/store.js";

const artifacts = join(
  process.cwd(),
  ".codex/artifacts/notifications-20260927",
);
let directory: string;
let now: number;
let presence: NotificationPresence;
const changed = vi.fn();
const deliver = vi.fn(async () => ({ status: "submitted" as const }));

beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  directory = await mkdtemp(join(artifacts, "service-test-"));
  now = 1_000;
  presence = new NotificationPresence(() => now);
  changed.mockClear();
  deliver.mockClear();
  deliver.mockResolvedValue({ status: "submitted" });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function environment(id: string) {
  return {
    services: {
      config: {
        paths: {
          runtimeDir: join(directory, id, "runtime"),
          sessionsDir: join(directory, id, "sessions"),
        },
      } as RuntimeConfig,
    },
  };
}

function createService() {
  return new WebNotificationService({
    hasEnvironment: (id) => ["dev", "prod"].includes(id),
    environment,
    isViewing: (env, session) => presence.isViewing(env, session),
    changed,
    desktop: async () => ({ available: true }),
    deliver,
    now: () => now++,
  });
}

function reply(overrides: Record<string, unknown> = {}) {
  return {
    type: "completed",
    requestId: "request-1",
    environment: "dev",
    sessionId: "session-1",
    output: "The requested changes are ready.",
    ...overrides,
  };
}

test("attention is scoped to a visible conversation and expires without a browser heartbeat", async () => {
  const client = {};
  presence.update(client, {
    environment: "dev",
    sessionId: "session-1",
    active: true,
  });
  const service = createService();
  service.observe(reply());
  service.observe(reply({ environment: "prod" }));
  await service.flush();
  expect((await service.list("dev")).items).toHaveLength(0);
  expect((await service.list("prod")).items).toHaveLength(1);
  now += 60_001;
  service.observe(reply());
  await service.flush();
  expect((await service.list("dev")).items).toHaveLength(1);
  expect(deliver).toHaveBeenCalledTimes(2);
});

test("history, read state and desktop preferences survive a restart, without resending", async () => {
  const service = createService();
  service.observe(reply());
  service.observe(reply());
  await service.flush();
  const page = await service.list("dev");
  expect(page.items).toHaveLength(1);
  expect(page.items[0].delivery.status).toBe("submitted");
  await service.markRead("dev", { ids: [page.items[0].id], read: true });
  await service.setPreferences("dev", {
    ...page.preferences,
    desktopEnabled: false,
  });
  const restarted = createService();
  restarted.observe(reply());
  restarted.observe(reply({ requestId: "request-2" }));
  await restarted.flush();
  const retained = await restarted.list("dev");
  expect(retained.items).toHaveLength(2);
  expect(retained.unreadCount).toBe(1);
  expect(
    retained.items.find((item) => item.requestId === "request-2")?.delivery
      .status,
  ).toBe("disabled");
  expect(deliver).toHaveBeenCalledTimes(1);
});

test("approval, failure and Co-worker events create one source-linked entry each", async () => {
  const service = createService();
  const approval = {
    type: "event",
    name: "tool.approval.required",
    environment: "dev",
    sessionId: "session-1",
    requestId: "request-1",
    approvalId: "approval-1",
  };
  service.observe(approval);
  service.observe(approval);
  service.observe(reply({ type: "failed", error: "provider failed" }));
  service.observe({
    type: "learning.changed",
    environmentId: "dev",
    event: {
      type: "proposal_delivered",
      proposalId: "proposal-1",
      sessionId: "suggestion-1",
    },
  });
  service.observe({
    type: "workspace_changed",
    environment: "dev",
    resources: ["sessions"],
  });
  service.observe(reply({ type: "event", name: "response.delta" }));
  service.observe(reply({ environment: "unknown" }));
  await service.flush();
  const page = await service.list("dev");
  expect(page.items.map((item) => item.kind).sort()).toEqual([
    "approval",
    "failure",
    "proposal",
  ]);
  expect(
    page.items.every((item) =>
      item.sourceUrl.startsWith("/chat?environment=dev&session="),
    ),
  ).toBe(true);
  expect(deliver).toHaveBeenCalledTimes(3);
});

test("direct replay sends do not create history and closing a socket clears attention", async () => {
  const service = createService();
  const hub = new RealtimeClientHub((event) => service.observe(event));
  const client = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    send: vi.fn(),
  }) as unknown as WebSocket;
  hub.add(client);
  hub.presence.update(client, {
    environment: "dev",
    sessionId: "session-1",
    active: true,
  });
  expect(hub.presence.isViewing("dev", "session-1")).toBe(true);
  hub.send(client, reply());
  await service.flush();
  expect((await service.list("dev")).items).toHaveLength(0);
  client.emit("close");
  expect(hub.presence.isViewing("dev", "session-1")).toBe(false);
  hub.broadcast(reply());
  await service.flush();
  expect((await service.list("dev")).items).toHaveLength(1);
});

test("a persisted interrupted delivery becomes uncertain and is never replayed", async () => {
  const item = projectNotificationEvent(reply(), now)!;
  const paths = environment("dev").services.config.paths;
  const store = new WebNotificationStore(
    notificationStorePath({ ...paths, environmentId: "dev" }),
    "dev",
  );
  await store.upsert(item);
  const service = createService();
  const page = await service.list("dev");
  expect(page.items[0].delivery.status).toBe("unknown");
  service.observe(reply());
  await service.flush();
  expect(deliver).not.toHaveBeenCalled();
});

test("cancellation only notifies about an actually persisted assistant acknowledgement", () => {
  const cancelled = reply({ type: "failed", error: "request_cancelled" });
  expect(projectNotificationEvent(cancelled, now)).toBeUndefined();
  expect(
    projectNotificationEvent(
      {
        ...cancelled,
        details: { stoppedResponse: "I stopped the task at your request." },
      },
      now,
    )?.kind,
  ).toBe("reply");
});
