import { expect, test, vi } from "vitest";
import { DesktopNotificationDelivery } from "../../web-ui/notifications/desktop-delivery.js";
import {
  DESKTOP_NOTIFICATION_CAPABILITY,
  readDesktopNotification,
} from "../../computer-access/companion/notification-protocol.js";
import { projectNotificationEvent } from "../../web-ui/notifications/event-projection.js";
import {
  isHostToolResult,
  type HostStatus,
} from "../../computer-access/companion/protocol.js";

const item = projectNotificationEvent(
  {
    type: "completed",
    environment: "dev",
    sessionId: "session-1",
    requestId: "request-1",
    output: "Ready",
  },
  1_000,
)!;
const connected: HostStatus = {
  paired: true,
  connected: true,
  hostId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  connectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  identity: {
    os: "windows",
    name: "My computer",
    user: "user",
    homeDir: "C:/Users/user",
  },
  capabilities: [DESKTOP_NOTIFICATION_CAPABILITY],
};

test.each<HostStatus>([
  { paired: false, connected: false },
  { ...connected, connected: false, connectionId: undefined },
  { ...connected, capabilities: [] },
])(
  "disconnected or older companions retain history without dispatch",
  async (status) => {
    const execute = vi.fn();
    const sender = new DesktopNotificationDelivery("/installation", {
      status: async () => status,
      execute,
    });
    expect((await sender.send(item, new AbortController().signal)).status).toBe(
      "unavailable",
    );
    expect(execute).not.toHaveBeenCalled();
  },
);

test("binds delivery to observed native host connection and uses a relative source for Docker ports", async () => {
  const execute = vi.fn(async () => ({
    ok: true,
    output: "submitted",
    producedNewInformation: false,
  }));
  const sender = new DesktopNotificationDelivery("/installation", {
    status: async () => connected,
    execute,
  });
  expect(await sender.send(item, new AbortController().signal)).toEqual({
    status: "submitted",
  });
  expect(execute).toHaveBeenCalledWith(
    "/installation",
    expect.objectContaining({
      hostId: connected.hostId,
      connectionId: connected.connectionId,
      operation: "desktop_notification",
      params: expect.objectContaining({
        target: "windows",
        notificationId: item.id,
        url: item.sourceUrl,
      }),
    }),
  );
});

test.each(["system_host_outcome_unknown", "notification_outcome_unknown"])(
  "a lost result stays uncertain and never triggers another send (%s)",
  async (errorCode) => {
    const execute = vi.fn(async () => ({
      ok: false,
      output: "connection lost",
      errorCode,
      producedNewInformation: false,
    }));
    const sender = new DesktopNotificationDelivery("/installation", {
      status: async () => connected,
      execute,
    });
    expect((await sender.send(item, new AbortController().signal)).status).toBe(
      "unknown",
    );
    expect(execute).toHaveBeenCalledTimes(1);
  },
);

test("a broken companion status remains a desktop availability issue", async () => {
  const sender = new DesktopNotificationDelivery("/installation", {
    status: async () => {
      throw new Error("pairing file unreadable");
    },
    execute: vi.fn(),
  });
  expect(await sender.status()).toMatchObject({ available: false });
});

test("oversized native error output fits durable history limits", async () => {
  const sender = new DesktopNotificationDelivery("/installation", {
    status: async () => connected,
    execute: async () => ({
      ok: false,
      output: "x".repeat(10_000),
      producedNewInformation: false,
    }),
  });
  const result = await sender.send(item, new AbortController().signal);
  expect(result.status).toBe("failed");
  expect(result.error!.length).toBeLessThanOrEqual(500);
});

test("a projected reply crosses the native validator and keeps the paired Docker origin", async () => {
  const reply = projectNotificationEvent(
    {
      type: "completed",
      environment: "dev",
      sessionId: "session-1",
      requestId: "request-2",
      output: "Ready\u0000\n עכשיו",
    },
    2_000,
  )!;
  let nativeSource = "";
  const sender = new DesktopNotificationDelivery("/installation", {
    status: async () => connected,
    execute: async (_root, request) => {
      const parsed = readDesktopNotification(
        request.params,
        "windows",
        "ws://localhost:4123/system-host/connect",
      );
      expect(parsed.notificationId).toBe(reply.id);
      expect(parsed.body).toBe("Ready עכשיו");
      nativeSource = parsed.url;
      return { ok: true, output: "submitted", producedNewInformation: false };
    },
  });
  expect((await sender.send(reply, new AbortController().signal)).status).toBe(
    "submitted",
  );
  expect(nativeSource).toBe(
    "http://localhost:4123/chat?environment=dev&session=session-1",
  );
});

test("preserves the structured native failure before transport evidence fills the history limit", async () => {
  const sender = new DesktopNotificationDelivery("/installation", {
    status: async () => connected,
    execute: async () => ({
      ok: false,
      output: "Execution transport: host_companion. " + "evidence ".repeat(100),
      error: "Windows notification registration was not found (0x80070490).",
      errorCode: "notification_native_failed",
      producedNewInformation: false,
    }),
  });
  expect(await sender.send(item, new AbortController().signal)).toEqual({
    status: "failed",
    error: "Windows notification registration was not found (0x80070490).",
  });
});

test.each([{}, 42, false, ["untrusted"], null])(
  "a malformed host error retains the validated failure output (%j)",
  async (error) => {
    const hostResult: unknown = {
      ok: false,
      output: "The host could not submit this notification.",
      error,
      producedNewInformation: false,
    };
    if (!isHostToolResult(hostResult))
      throw new Error(
        "Regression fixture must pass the current host wire guard",
      );
    const sender = new DesktopNotificationDelivery("/installation", {
      status: async () => connected,
      execute: async () => hostResult,
    });
    expect(await sender.send(item, new AbortController().signal)).toEqual({
      status: "failed",
      error: "The host could not submit this notification.",
    });
  },
);
