import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { LinuxNotificationRenderer } from "../../computer-access/companion/notification-linux.js";
import type { NotificationProcessRunner } from "../../computer-access/companion/notification-process.js";
import type { DesktopNotification } from "../../computer-access/companion/notification-protocol.js";

const renderers: LinuxNotificationRenderer[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.close();
});

function notification(index: number): DesktopNotification {
  return {
    target: "linux",
    notificationId: index.toString(16).padStart(64, "0"),
    title: `Reply ${index}`,
    body: `Result ${index}`,
    url: `http://abot.localhost:5987/chat?environment=dev&session=session-${index}`,
  };
}

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit("close", 0);
      return true;
    }),
  });
  return child;
}

function fixture(automaticAcknowledgement = true) {
  const children: ReturnType<typeof childProcess>[] = [];
  let active = 0;
  let peak = 0;
  const start = vi.fn(() => {
    const child = childProcess();
    const id = children.length + 100;
    children.push(child);
    active++;
    peak = Math.max(peak, active);
    child.once("close", () => {
      active--;
    });
    if (automaticAcknowledgement)
      queueMicrotask(() => child.stdout.write(`${id}\n`));
    return child;
  });
  const run = vi.fn<NotificationProcessRunner>(async (input) =>
    input.args.includes("org.freedesktop.Notifications.GetCapabilities")
      ? "(['actions'],)"
      : "()",
  );
  const renderer = new LinuxNotificationRenderer(
    start as unknown as typeof spawn,
    run,
  );
  renderers.push(renderer);
  return {
    renderer,
    children,
    start,
    run,
    peak: () => peak,
    active: () => active,
  };
}

test("more than 32 desktop alerts recycle oldest native IDs and keep every new click bound to its source", async () => {
  const f = fixture();
  for (let index = 0; index < 40; index++)
    await f.renderer.send(notification(index));
  const closures = f.run.mock.calls.filter(([input]) =>
    input.args.includes("org.freedesktop.Notifications.CloseNotification"),
  );
  expect(closures.map(([input]) => input.args.at(-1))).toEqual(
    Array.from({ length: 8 }, (_, index) => String(index + 100)),
  );
  expect(closures.every(([input]) => input.timeoutMs === 2000)).toBe(true);
  expect(f.peak()).toBeLessThanOrEqual(32);
  expect(f.active()).toBe(32);
  expect(f.start).toHaveBeenCalledTimes(40);
  for (const child of f.children.slice(0, 8)) {
    expect(child.kill).toHaveBeenCalledOnce();
    child.stdout.write("default\n");
  }
  for (let index = 8; index < 40; index++)
    f.children[index].stdout.write("default\n");
  expect(
    f.run.mock.calls
      .filter(([input]) => input.file === "xdg-open")
      .map(([input]) => input.args[0]),
  ).toEqual(
    Array.from({ length: 32 }, (_, index) => notification(index + 8).url),
  );
});

test("a failed daemon close preserves the existing click and a later alert can recycle the slot", async () => {
  const f = fixture();
  for (let index = 0; index < 32; index++)
    await f.renderer.send(notification(index));
  f.run.mockImplementationOnce(async () => "(['actions'],)");
  f.run.mockRejectedValueOnce(new Error("daemon close failed"));
  await expect(f.renderer.send(notification(32))).rejects.toThrow(
    "daemon close failed",
  );
  expect(f.children[0].kill).not.toHaveBeenCalled();
  f.children[0].stdout.write("default\n");
  expect(f.run).toHaveBeenCalledWith({
    file: "xdg-open",
    args: [notification(0).url],
  });
  await f.renderer.send(notification(33));
  expect(f.start).toHaveBeenCalledTimes(33);
  expect(f.children[0].kill).toHaveBeenCalledOnce();
  f.children[0].stdout.write("default\n");
  f.children[32].stdout.write("default\n");
  expect(
    f.run.mock.calls
      .filter(([input]) => input.file === "xdg-open")
      .map(([input]) => input.args[0]),
  ).toEqual([notification(0).url, notification(33).url]);
});

test("a replacement waits for the retired process to exit before starting another listener", async () => {
  const f = fixture();
  for (let index = 0; index < 32; index++)
    await f.renderer.send(notification(index));
  f.children[0].kill.mockImplementation(() => true);
  const pending = f.renderer.send(notification(32));
  await vi.waitFor(() => expect(f.children[0].kill).toHaveBeenCalledOnce());
  expect(f.start).toHaveBeenCalledTimes(32);
  f.children[0].stdout.write("default\n");
  expect(f.run.mock.calls.some(([input]) => input.file === "xdg-open")).toBe(
    false,
  );
  f.children[0].emit("close", 0);
  await pending;
  expect(f.start).toHaveBeenCalledTimes(33);
  expect(f.peak()).toBe(32);
});

test("in-flight submissions wait for their own ID and are never recycled as acknowledged alerts", async () => {
  const f = fixture(false);
  const first = f.renderer.send(notification(0));
  const second = f.renderer.send(notification(1));
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  f.children[0].stdout.write("100\n");
  await first;
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
  let submitted = false;
  const observed = second.then(() => {
    submitted = true;
  });
  f.children[1].stdout.write("default\n");
  await Promise.resolve();
  expect(submitted).toBe(false);
  expect(f.run.mock.calls.some(([input]) => input.file === "xdg-open")).toBe(
    false,
  );
  f.children[1].stdout.write("101\n");
  await observed;
  expect(f.children.every((child) => child.kill.mock.calls.length === 0)).toBe(
    true,
  );
});

test("shutdown during capability discovery cannot start a process afterwards", async () => {
  const f = fixture();
  let release: (value: string) => void = () => undefined;
  f.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.renderer.send(notification(0));
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  f.renderer.close();
  release("(['actions'],)");
  await rejected;
  expect(f.start).not.toHaveBeenCalled();
  await expect(f.renderer.send(notification(1))).rejects.toThrow();
  expect(f.start).not.toHaveBeenCalled();
});

test("shutdown rejects in-flight and queued work and disables late action output", async () => {
  const f = fixture(false);
  const first = expect(f.renderer.send(notification(0))).rejects.toThrow();
  const second = expect(f.renderer.send(notification(1))).rejects.toThrow();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  f.renderer.close();
  await Promise.all([first, second]);
  expect(f.start).toHaveBeenCalledOnce();
  f.children[0].stdout.write("100\ndefault\n");
  expect(f.run.mock.calls.some(([input]) => input.file === "xdg-open")).toBe(
    false,
  );
});

test("an aborted or failed submission cannot accept late acknowledgements or clicks and later work continues", async () => {
  const f = fixture(false);
  const abort = new AbortController();
  const aborted = expect(
    f.renderer.send(notification(0), abort.signal),
  ).rejects.toThrow();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  abort.abort();
  await aborted;
  f.children[0].stdout.write("100\ndefault\n");
  const failed = expect(f.renderer.send(notification(1))).rejects.toThrow(
    "spawn failed",
  );
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
  f.children[1].emit("error", new Error("spawn failed"));
  await failed;
  f.children[1].stdout.write("101\ndefault\n");
  const submitted = f.renderer.send(notification(2));
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(3));
  f.children[2].stdout.write("102\ndefault\n");
  await submitted;
  expect(
    f.run.mock.calls
      .filter(([input]) => input.file === "xdg-open")
      .map(([input]) => input.args[0]),
  ).toEqual([notification(2).url]);
});

test("abort after acknowledged submission leaves the notification action listener alive", async () => {
  const f = fixture();
  const abort = new AbortController();
  await f.renderer.send(notification(0), abort.signal);
  abort.abort();
  expect(f.children[0].kill).not.toHaveBeenCalled();
  f.children[0].stdout.write("default\n");
  expect(f.run).toHaveBeenCalledWith({
    file: "xdg-open",
    args: [notification(0).url],
  });
});
