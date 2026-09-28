import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeConfig } from "../ports.js";
import {
  defaultNotificationPreferences,
  type NotificationDelivery,
  type NotificationPreferences,
  type WebNotification,
} from "../../web-ui/notifications/contracts.js";
import { WebNotificationService } from "../../web-ui/notifications/service.js";
import {
  WebNotificationStore,
  notificationStorePath,
} from "../../web-ui/notifications/store.js";

const artifacts = join(
  process.cwd(),
  ".codex/artifacts/notification-race-review-20260927",
);
let directory: string;

beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  directory = await mkdtemp(join(artifacts, "queued-preferences-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function paths(environmentId: string) {
  return {
    runtimeDir: join(directory, "runtime"),
    sessionsDir: join(directory, environmentId, "sessions"),
  };
}

function fixture() {
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deliver = vi.fn(
    async (
      _item: WebNotification,
      signal: AbortSignal,
    ): Promise<NotificationDelivery> => {
      await blocked;
      expect(signal.aborted).toBe(false);
      return { status: "submitted" };
    },
  );
  const service = new WebNotificationService({
    hasEnvironment: (id) => ["dev", "prod"].includes(id),
    environment: (id) => ({
      services: { config: { paths: paths(id) } as RuntimeConfig },
    }),
    isViewing: () => false,
    changed: () => undefined,
    desktop: async () => ({ available: true }),
    deliver,
  });
  return { service, deliver, release };
}

function observe(
  service: WebNotificationService,
  requestId: string,
  environment = "dev",
  kind = "reply",
) {
  service.observe({
    type: kind === "reply" ? "completed" : "failed",
    requestId,
    environment,
    sessionId: "session-1",
    output: "Your result is ready.",
  });
}

async function statusByRequest(
  service: WebNotificationService,
  environment = "dev",
) {
  const page = await service.list(environment);
  return Object.fromEntries(
    page.items.map((item) => [item.requestId, item.delivery.status]),
  );
}

const disableDesktop = (): NotificationPreferences => ({
  ...defaultNotificationPreferences(),
  desktopEnabled: false,
});
const disableReplies = (): NotificationPreferences => {
  const preferences = defaultNotificationPreferences();
  preferences.kinds.reply = false;
  return preferences;
};

test.each([
  {
    label: "desktop alerts",
    preferences: disableDesktop,
    failureStatus: "disabled",
    calls: 1,
  },
  {
    label: "reply alerts",
    preferences: disableReplies,
    failureStatus: "submitted",
    calls: 2,
  },
])(
  "disabling $label skips queued alerts but leaves an already dispatched alert intact",
  async ({ preferences, failureStatus, calls }) => {
    const f = fixture();
    observe(f.service, "active");
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
    observe(f.service, "queued-reply");
    observe(f.service, "queued-failure", "dev", "failure");
    try {
      await vi.waitFor(async () =>
        expect((await f.service.list("dev")).items).toHaveLength(3),
      );
      await f.service.setPreferences("dev", preferences());
    } finally {
      f.release();
      await f.service.flush();
    }
    expect(f.deliver).toHaveBeenCalledTimes(calls);
    expect(await statusByRequest(f.service)).toEqual({
      active: "submitted",
      "queued-reply": "disabled",
      "queued-failure": failureStatus,
    });
  },
);

test("queued deliveries read the latest persisted preferences for their own environment", async () => {
  const f = fixture();
  observe(f.service, "active-dev");
  await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
  observe(f.service, "queued-prod", "prod");
  observe(f.service, "queued-dev");
  try {
    await vi.waitFor(async () => {
      expect((await f.service.list("prod")).items).toHaveLength(1);
      expect((await f.service.list("dev")).items).toHaveLength(2);
    });
    const persisted = new WebNotificationStore(
      notificationStorePath({ environmentId: "prod", ...paths("prod") }),
      "prod",
    );
    await persisted.setPreferences(disableDesktop());
  } finally {
    f.release();
    await f.service.flush();
  }
  expect(f.deliver.mock.calls.map(([item]) => item.requestId)).toEqual([
    "active-dev",
    "queued-dev",
  ]);
  expect(await statusByRequest(f.service, "prod")).toEqual({
    "queued-prod": "disabled",
  });
  expect(await statusByRequest(f.service, "dev")).toEqual({
    "active-dev": "submitted",
    "queued-dev": "submitted",
  });
});

test("enabling alerts does not replay history that was disabled when recorded", async () => {
  const f = fixture();
  await f.service.setPreferences("dev", disableDesktop());
  observe(f.service, "disabled-original");
  await f.service.flush();
  await f.service.setPreferences("dev", defaultNotificationPreferences());
  observe(f.service, "disabled-original");
  await f.service.flush();
  expect(f.deliver).not.toHaveBeenCalled();
  observe(f.service, "new-enabled");
  f.release();
  await f.service.flush();
  expect(f.deliver).toHaveBeenCalledOnce();
  expect(await statusByRequest(f.service)).toEqual({
    "disabled-original": "disabled",
    "new-enabled": "submitted",
  });
});

test("a queued preference read failure prevents native dispatch and does not block later delivery", async () => {
  const f = fixture();
  const error = new Error("preference file unavailable");
  const reported = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  observe(f.service, "active");
  await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledOnce());
  observe(f.service, "unverified");
  observe(f.service, "later");
  try {
    await vi.waitFor(async () =>
      expect((await f.service.list("dev")).items).toHaveLength(3),
    );
    vi.spyOn(
      WebNotificationStore.prototype,
      "getPreferences",
    ).mockRejectedValueOnce(error);
  } finally {
    f.release();
    await f.service.flush();
  }
  expect(f.deliver.mock.calls.map(([item]) => item.requestId)).toEqual([
    "active",
    "later",
  ]);
  expect(await statusByRequest(f.service)).toEqual({
    active: "submitted",
    unverified: "pending",
    later: "submitted",
  });
  expect(reported).toHaveBeenCalledWith(
    "Notification history unavailable for dev:",
    error,
  );
});
