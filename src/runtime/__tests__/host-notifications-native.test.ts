import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import {
  readDesktopNotification,
  resolveNotificationSourceUrl,
} from "../../computer-access/companion/notification-protocol.js";
import { createNotificationSession } from "../../computer-access/companion/native-notifications.js";
import { renderMacNotificationApplet } from "../../computer-access/companion/notification-macos.js";
import { sendWindowsNotification } from "../../computer-access/companion/notification-windows.js";
import {
  linuxNotificationArguments,
  LinuxNotificationRenderer,
} from "../../computer-access/companion/notification-linux.js";
import {
  isHostOperation,
  isHostWireOperation,
} from "../../computer-access/companion/protocol.js";
import {
  assertNativeOperationTarget,
  readNativeServerMessage,
} from "../../computer-access/companion/native-messages.js";
import type { NotificationProcessRunner } from "../../computer-access/companion/notification-process.js";
import type { spawn } from "node:child_process";

const origin = "ws://abot-notify.localhost:5987";
const notification = {
  target: "windows" as const,
  notificationId: "a".repeat(64),
  title: "ABot result",
  body: "A result is ready",
  url: "/chat?environment=dev&session=session-1",
};

test("wire-only notifications retain native host binding and accept the persisted SHA256 identity", () => {
  expect(isHostOperation("desktop_notification")).toBe(false);
  expect(isHostWireOperation("desktop_notification")).toBe(true);
  const message = readNativeServerMessage(
    JSON.stringify({
      type: "execute",
      id: randomUUID(),
      hostId: randomUUID(),
      operation: "desktop_notification",
      params: notification,
    }),
  );
  if (message.type !== "execute") throw new Error("Expected execute");
  expect(() => assertNativeOperationTarget(message, "windows")).not.toThrow();
  expect(() => assertNativeOperationTarget(message, "macos")).toThrow();
  expect(
    readDesktopNotification(notification, "windows", origin).notificationId,
  ).toBe("a".repeat(64));
});

test.each([
  "https://example.com/chat",
  "//example.com/chat",
  "javascript:alert(1)",
  "/web-api/runtime/shutdown",
  "/chat?redirect=https://example.com",
  "/chat#external",
  "http://abot-notify.localhost:5988/chat",
  "/chat\\anything",
  "/chat\n",
])("rejects source destination %s outside the paired app route", (url) => {
  expect(() => resolveNotificationSourceUrl(url, origin)).toThrow();
});

test.each([
  { notificationId: "bad" },
  { notificationId: "A".repeat(64) },
  { title: "x".repeat(161) },
  { body: "x".repeat(1001) },
  { title: "\u0000injected" },
  { body: "\u001bescape" },
  { target: "host:123" },
  { arbitrary: "field" },
])(
  "rejects invalid native notification fields %j before execution",
  async (change) => {
    const renderer = { send: vi.fn(), close: vi.fn() };
    const session = createNotificationSession(
      "windows",
      origin,
      true,
      renderer,
    );
    expect(
      (
        await session.handlers().desktop_notification!({
          ...notification,
          ...change,
        })
      ).ok,
    ).toBe(false);
    expect(renderer.send).not.toHaveBeenCalled();
  },
);

test("Windows passes Unicode and shell/XML characters as stdin data and uses the paired published port", async () => {
  const run = vi.fn<NotificationProcessRunner>(async () => "");
  const validated = readDesktopNotification(
    {
      ...notification,
      title: "Unicode \u05e9\u05dc\u05d5\u05dd $(calc) & <text>",
      body: "Quote ' \" and newline\nsecond",
    },
    "windows",
    origin,
  );
  await sendWindowsNotification(validated, undefined, run);
  const request = run.mock.calls[0]?.[0] as any;
  expect(request.file).toBe("powershell.exe");
  const script = Buffer.from(request.args.at(-1), "base64").toString("utf16le");
  expect(script).not.toContain(validated.title);
  expect(script).toContain("com.abot.notifications");
  expect(script).toContain('activationType="protocol"');
  expect(JSON.parse(request.input)).toEqual({
    ...validated,
    url: "http://abot-notify.localhost:5987/chat?environment=dev&session=session-1",
  });
});

test("missing native registration and native rejection remain failures with no retry", async () => {
  const renderer = {
    send: vi.fn(async () => {
      throw new Error("notification_permission_denied");
    }),
    close: vi.fn(),
  };
  const unavailable = createNotificationSession(
    "windows",
    origin,
    false,
    renderer,
  );
  expect(
    (await unavailable.handlers().desktop_notification!(notification))
      .errorCode,
  ).toBe("notification_setup_required");
  const ready = createNotificationSession("windows", origin, true, renderer);
  expect(
    (await ready.handlers().desktop_notification!(notification)).output,
  ).toContain("permission_denied");
  expect(renderer.send).toHaveBeenCalledOnce();
  ready.close();
  expect(renderer.close).toHaveBeenCalledOnce();
});

test("Linux acknowledges submission before click, safely opens that source, and closes action listeners", async () => {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  const start = vi.fn((..._args: unknown[]) => child);
  const run = vi.fn<NotificationProcessRunner>(async (input) =>
    input.file === "gdbus" ? "([\'actions\'],)" : "",
  );
  const renderer = new LinuxNotificationRenderer(
    start as unknown as typeof spawn,
    run,
  );
  const payload = readDesktopNotification(
    { ...notification, target: "linux", body: "<b>text</b> & more" },
    "linux",
    origin,
  );
  const pending = renderer.send(payload);
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  child.stdout.write("47\n");
  await pending;
  expect(run.mock.calls.some(([input]) => input.file === "xdg-open")).toBe(
    false,
  );
  expect(start.mock.calls[0]?.[1]).toContain(
    "&lt;b&gt;text&lt;/b&gt; &amp; more",
  );
  child.stdout.write("default\n");
  await Promise.resolve();
  expect(run).toHaveBeenCalledWith({ file: "xdg-open", args: [payload.url] });
  renderer.close();
  expect(child.kill).toHaveBeenCalledOnce();
});

test("Mac applet executes payload and click logic with its registered delegate and rejects a revoked origin", () => {
  const directory = "/users/test/.abot/host-companion";
  const path = directory + "/notifications/pending/" + randomUUID() + ".json";
  const files = new Map<string, string>([
    [directory + "/connection.json", JSON.stringify({ url: origin })],
    [
      path,
      JSON.stringify({
        ...notification,
        target: "macos",
        url: "http://abot-notify.localhost:5987/chat?environment=dev",
        expiresAt: Date.now() + 10_000,
      }),
    ],
  ]);
  const delivered: any[] = [];
  const opened: string[] = [];
  let methods: any;
  const center = {
    deliverNotification: (value: unknown) => delivered.push(value),
    removeDeliveredNotification: vi.fn(),
  };
  const wrap = Object.assign(
    (value: any): any => {
      if (typeof value !== "string") return value;
      return {
        toString: () => value,
        stringByResolvingSymlinksInPath: value,
        writeToFileAtomicallyEncodingError: (target: any) => {
          files.set(String(target), value);
          return true;
        },
      };
    },
    {
      NSUserNotificationCenter: { defaultUserNotificationCenter: center },
      NSString: {
        stringWithContentsOfFileEncodingError: (file: any) =>
          wrap(files.get(String(file))),
      },
      NSUTF8StringEncoding: 4,
      NSUserNotification: { alloc: {} },
      ABotDesktopNotificationDelegate: { alloc: { init: {} } },
      NSWorkspace: {
        sharedWorkspace: { openURL: (url: any) => opened.push(String(url)) },
      },
      NSURL: { URLWithString: (url: any) => url },
    },
  );
  Object.defineProperty(wrap.NSUserNotification.alloc, "init", {
    get: () => ({}),
  });
  const context: any = {
    $: wrap,
    ObjC: {
      import: () => {},
      unwrap: (value: any) => String(value),
      deepUnwrap: (value: any) => value,
      registerSubclass: (value: any) => {
        methods = value.methods;
      },
    },
  };
  runInNewContext(renderMacNotificationApplet(directory), context);
  context.openDocuments([path]);
  expect(delivered).toHaveLength(1);
  expect(JSON.parse(files.get(path + ".result")!)).toEqual({ ok: true });
  const activate =
    methods["userNotificationCenter:didActivateNotification:"].implementation;
  activate(center, delivered[0]);
  expect(opened).toEqual([
    "http://abot-notify.localhost:5987/chat?environment=dev",
  ]);
  files.set(
    directory + "/connection.json",
    JSON.stringify({ url: "ws://other.localhost:5987" }),
  );
  activate(center, delivered[0]);
  expect(opened).toHaveLength(1);
  context.openDocuments(["/outside/" + randomUUID() + ".json"]);
  expect(delivered).toHaveLength(1);
});

test("Linux preserves literal backslashes through notify-send body unescaping", () => {
  const value = readDesktopNotification(
    { ...notification, target: "linux", body: "C:\\temp\\result & <body>" },
    "linux",
    origin,
  );
  expect(linuxNotificationArguments(value).at(-1)).toBe(
    "C:\\\\temp\\\\result &amp; &lt;body&gt;",
  );
});

test("ambiguous native submission timeout is reported unknown and is not retried", async () => {
  const renderer = {
    send: vi.fn(async () => {
      throw new Error("notification_native_timeout");
    }),
    close: vi.fn(),
  };
  const native = createNotificationSession("windows", origin, true, renderer);
  expect(
    (await native.handlers().desktop_notification!(notification)).errorCode,
  ).toBe("notification_outcome_unknown");
  expect(renderer.send).toHaveBeenCalledOnce();
});
