import { spawn, type ChildProcess } from "node:child_process";
import type { DesktopNotification } from "./notification-protocol.js";
import { NOTIFICATION_APP_ID } from "./notification-locations.js";
import {
  runNotificationProcess,
  type NotificationProcessRunner,
} from "./notification-process.js";

function notificationMarkupText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function hasLinuxNotificationActions(
  run: NotificationProcessRunner,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const capabilities = await run({
    file: "gdbus",
    args: [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.Notifications",
      "--object-path",
      "/org/freedesktop/Notifications",
      "--method",
      "org.freedesktop.Notifications.GetCapabilities",
    ],
    timeoutMs: 2000,
    signal,
  });
  signal?.throwIfAborted();
  return /['"]actions['"]/u.test(capabilities);
}

export function linuxNotificationArguments(
  notification: DesktopNotification,
): string[] {
  return [
    "--app-name=ABot",
    "--print-id",
    "--wait",
    "--action=default=Open in ABot",
    "--hint=string:desktop-entry:" + NOTIFICATION_APP_ID,
    "--hint=boolean:suppress-sound:true",
    "--expire-time=86400000",
    "--",
    notification.title,
    notificationMarkupText(notification.body),
  ];
}

type LinuxNotificationListener = {
  nativeId?: string;
  stop(): void;
  exited: Promise<void>;
};

/** Retain actions for the latest 32 desktop alerts; older history stays in ABot. */
export class LinuxNotificationRenderer {
  private readonly children = new Map<
    ChildProcess,
    LinuxNotificationListener
  >();
  private readonly shutdown = new AbortController();
  private submissions: Promise<void> = Promise.resolve();
  constructor(
    private readonly start = spawn,
    private readonly run: NotificationProcessRunner = runNotificationProcess,
  ) {}

  send(notification: DesktopNotification, signal?: AbortSignal): Promise<void> {
    const lifetime = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    const submitted = this.submissions.then(() =>
      this.submit(notification, lifetime),
    );
    this.submissions = submitted.catch(() => undefined);
    return submitted;
  }

  private needsListenerRecycling(): boolean {
    return this.children.size >= 32;
  }

  private async recycleOldestListener(signal: AbortSignal): Promise<void> {
    if (!this.needsListenerRecycling()) return;
    const listener = this.children.values().next().value;
    if (!listener) return;
    if (listener.nativeId) {
      await this.run({
        file: "gdbus",
        args: [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.Notifications",
          "--object-path",
          "/org/freedesktop/Notifications",
          "--method",
          "org.freedesktop.Notifications.CloseNotification",
          listener.nativeId,
        ],
        signal,
        timeoutMs: 2000,
      });
    }
    listener.stop();
    await this.waitForListenerExit(listener, signal);
  }

  private waitForListenerExit(
    listener: LinuxNotificationListener,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => finish(new Error("notification_native_timeout")),
        2000,
      );
      const abort = () => finish(new Error("notification_cancelled"));
      function finish(error?: Error) {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      }
      signal.addEventListener("abort", abort, { once: true });
      void listener.exited.then(() => finish());
      if (signal.aborted) abort();
    });
  }

  private async submit(
    notification: DesktopNotification,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!(await hasLinuxNotificationActions(this.run, signal)))
      throw new Error("notification_actions_unavailable");
    signal.throwIfAborted();
    await this.recycleOldestListener(signal);
    signal.throwIfAborted();
    const child = this.start(
      "notify-send",
      linuxNotificationArguments(notification),
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let markExited: () => void = () => undefined;
    const listener: LinuxNotificationListener = {
      stop: () => undefined,
      exited: new Promise((resolve) => {
        markExited = resolve;
      }),
    };
    this.children.set(child, listener);
    return new Promise((resolve, reject) => {
      let output = "";
      let errors = "";
      let submitted = false;
      let settled = false;
      let listening = true;
      const deadline = setTimeout(
        () => fail(new Error("notification_native_timeout")),
        10_000,
      );
      const abort = () => fail(new Error("notification_cancelled"));
      function finish(error?: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      }
      function fail(error: Error) {
        if (!listening) return;
        listening = false;
        finish(error);
        child.kill();
      }
      listener.stop = () => fail(new Error("notification_cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        if (!listening) return;
        output += chunk;
        if (output.length > 4096) {
          fail(new Error("notification_native_output_limit"));
          return;
        }
        let boundary = output.indexOf("\n");
        while (boundary >= 0) {
          const line = output.slice(0, boundary).trim();
          output = output.slice(boundary + 1);
          if (!submitted && /^[1-9][0-9]*$/.test(line)) {
            submitted = true;
            listener.nativeId = line;
            finish();
          } else if (submitted && line === "default") {
            void this.run({ file: "xdg-open", args: [notification.url] }).catch(
              () => {},
            );
          }
          boundary = output.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        errors = (errors + chunk).slice(-4096);
      });
      child.once("error", (error) => {
        listening = false;
        this.children.delete(child);
        markExited();
        finish(error);
      });
      child.once("close", () => {
        listening = false;
        this.children.delete(child);
        markExited();
        if (!submitted)
          finish(new Error(errors.trim() || "notification_native_failed"));
      });
      if (signal?.aborted) abort();
    });
  }

  close(): void {
    this.shutdown.abort();
    for (const listener of this.children.values()) listener.stop();
  }
}
