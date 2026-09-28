const boundary = vi.hoisted(() => ({ run: vi.fn(), backend: vi.fn() }));
vi.mock("../../computer-access/companion/notification-process.js", () => ({
  runNotificationProcess: boundary.run,
}));
vi.mock("../../computer-access/computer/native-backend.js", () => ({
  createNativeComputerBackend: boundary.backend,
}));

import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runNativeHostSupervisor } from "../../computer-access/companion/native-supervisor.js";
import {
  connectNativeHost,
  type NativeSessionOptions,
} from "../../computer-access/companion/native-session.js";
import {
  NATIVE_STATUS_INTERVAL_MS,
  type NativeHostState,
} from "../../computer-access/companion/native-state.js";
import {
  NOTIFICATION_OWNER_MARKER,
  notificationInstallDirectory,
} from "../../computer-access/companion/notification-locations.js";
import { linuxNotificationDesktopPath } from "../../computer-access/companion/notification-installation.js";
import { DESKTOP_NOTIFICATION_CAPABILITY } from "../../computer-access/companion/notification-protocol.js";
import type { NotificationProcessInput } from "../../computer-access/companion/notification-process.js";
import type { ToolImplementation } from "../../plugin-sdk/index.js";
import {
  companionImageFixture,
  companionObservation,
} from "./computer-companion-fixtures.js";
import { COMPUTER_FRAME_CHUNK_BYTES } from "../../computer-access/computer/native-validation.js";

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  boundary.run.mockReset();
  boundary.backend.mockReset();
  boundary.run.mockImplementation(async (input: NotificationProcessInput) =>
    input.file === "notify-send"
      ? "--wait --action --print-id"
      : "(['actions'],)",
  );
  vi.stubEnv("DISPLAY", ":99");
  vi.stubEnv("XDG_DATA_HOME", "");
});

test.skipIf(process.platform !== "linux")(
  "capability recovery waits for multipart computer frames and their connection-owned session to close",
  async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await transportFixture();
    boundary.run.mockRejectedValueOnce(
      new Error("notification service starting"),
    );
    const image = companionImageFixture();
    const expected = Buffer.from(image);
    const observed = companionObservation(image);
    const native = {
      execute: vi.fn(async () => ({
        ...observed,
        desktop: { ...observed.desktop, platform: "linux" as const },
      })),
      close: vi.fn(async () => {}),
    };
    boundary.backend.mockReturnValue(native);
    const sessionId = randomUUID();
    const running = runNativeHostSupervisor({
      ...f,
      connect: connectNativeHost,
      signal: f.stop.signal,
      reconnectDelayMs: 1,
    });
    async function request(
      operation: string,
      params: Record<string, unknown> = {},
    ) {
      const id = randomUUID();
      f.sockets[0].send(
        JSON.stringify({
          type: "execute",
          id,
          hostId: f.saved.hostId,
          operation,
          params: { ...params, sessionId, target: "linux" },
        }),
      );
      await vi.waitFor(() =>
        expect(f.messages.some((message) => message.id === id)).toBe(true),
      );
      return f.messages.find((message) => message.id === id)!.result as {
        ok: boolean;
        data: {
          frame?: { id: string; size: number; sha256: string };
          bytes?: string;
        };
      };
    }
    try {
      await vi.waitFor(() => expect(f.messages).toHaveLength(1));
      const receipt = await request("computer_execute", {
        request: { operation: "observe" },
      });
      expect(receipt.ok).toBe(true);
      const frame = receipt.data.frame!;
      expect(frame.size).toBeGreaterThan(COMPUTER_FRAME_CHUNK_BYTES);
      await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS);
      await vi.waitFor(() =>
        expect(
          boundary.run.mock.calls.some(([input]) => input.file === "gdbus"),
        ).toBe(true),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(f.closed).toEqual([]);
      expect(native.close).not.toHaveBeenCalled();
      const chunks: Buffer[] = [];
      for (
        let offset = 0;
        offset < frame.size;
        offset += COMPUTER_FRAME_CHUNK_BYTES
      ) {
        const chunk = await request("computer_frame", {
          frameId: frame.id,
          offset,
        });
        expect(chunk.ok).toBe(true);
        chunks.push(Buffer.from(chunk.data.bytes!, "base64"));
      }
      const result = Buffer.concat(chunks);
      expect(result).toEqual(expected);
      expect(createHash("sha256").update(result).digest("hex")).toBe(
        frame.sha256,
      );
      expect(f.closed).toEqual([]);
      expect((await request("computer_close")).ok).toBe(true);
      await vi.waitFor(() =>
        expect(
          f.messages.filter((message) => message.type === "hello"),
        ).toHaveLength(2),
      );
      expect(f.closed).toContain("capabilities_changed");
      expect(native.close).toHaveBeenCalledOnce();
      expect(f.messages.at(-1)?.capabilities).toContain(
        DESKTOP_NOTIFICATION_CAPABILITY,
      );
    } finally {
      f.stop.abort();
      await running;
    }
  },
);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const artifacts = resolve(
    ".codex/artifacts/notification-startup-review-20260927",
  );
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "readiness-"));
  directories.push(directory);
  const locations = { stateDir: join(directory, "state"), homeDir: directory };
  const owned = notificationInstallDirectory(locations);
  const desktop = linuxNotificationDesktopPath(locations);
  await mkdir(owned, { recursive: true });
  await mkdir(dirname(desktop), { recursive: true });
  await writeFile(join(owned, ".owner"), NOTIFICATION_OWNER_MARKER);
  await writeFile(join(owned, ".ready"), "linux");
  await writeFile(desktop, "fixture desktop identity");
  const saved = {
    version: 1 as const,
    url: "http://127.0.0.1:5199",
    hostId: randomUUID(),
    credential: "a".repeat(43),
  };
  let present = true;
  let changed = () => {};
  const unwatch = vi.fn();
  const state: NativeHostState = {
    directory: locations.stateDir,
    read: vi.fn(async () => (present ? saved : undefined)),
    write: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    isConnected: vi.fn(async () => false),
    watch: (callback) => {
      changed = callback;
      return unwatch;
    },
  };
  const stop = new AbortController();
  const identity = {
    os: "linux" as const,
    name: "fixture",
    user: "qa",
    homeDir: directory,
  };
  const connect = vi.fn(
    async (_options: NativeSessionOptions) => "stopped" as const,
  );
  return {
    state,
    saved,
    stop,
    identity,
    connect,
    unwatch,
    remove: () => {
      present = false;
      changed();
    },
  };
}

function pauseProbe(file: string) {
  const calls: NotificationProcessInput[] = [];
  let release = () => {};
  boundary.run.mockImplementation(async (input: NotificationProcessInput) => {
    if (input.file !== file) return "--wait --action --print-id";
    calls.push(input);
    return new Promise<string>((resolve, reject) => {
      const abort = () => reject(new DOMException("Stopped", "AbortError"));
      input.signal?.addEventListener("abort", abort, { once: true });
      release = () => {
        input.signal?.removeEventListener("abort", abort);
        resolve(
          file === "gdbus" ? "(['actions'],)" : "--wait --action --print-id",
        );
      };
    });
  });
  return { calls, release: () => release() };
}

test.each(["notify-send", "gdbus"])(
  "supervisor cancellation reaches a pending %s startup probe before connecting",
  async (file) => {
    const f = await fixture();
    const probe = pauseProbe(file);
    const running = runNativeHostSupervisor({ ...f, signal: f.stop.signal });
    try {
      await vi.waitFor(() => expect(probe.calls).toHaveLength(1));
      f.stop.abort();
      expect(probe.calls[0].signal?.aborted).toBe(true);
      await running;
      expect(f.connect).not.toHaveBeenCalled();
    } finally {
      f.stop.abort();
      probe.release();
      await running;
    }
  },
);

test("an already-aborted supervisor performs no readiness probes or connection attempt", async () => {
  const f = await fixture();
  f.stop.abort();
  await runNativeHostSupervisor({ ...f, signal: f.stop.signal });
  expect(boundary.run).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
});

test("rechecks are non-overlapping and pairing removal aborts a pending probe without waiting for it", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const f = await fixture();
  boundary.run.mockRejectedValueOnce(new Error("desktop not ready yet"));
  f.connect.mockImplementation(async (options) => {
    await options.onReady(f.saved.hostId);
    return new Promise<"stopped">((resolve) =>
      options.signal.addEventListener("abort", () => resolve("stopped"), {
        once: true,
      }),
    );
  });
  const running = runNativeHostSupervisor({ ...f, signal: f.stop.signal });
  let probe: ReturnType<typeof pauseProbe> | undefined;
  try {
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
    probe = pauseProbe("gdbus");
    await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS);
    await vi.waitFor(() => expect(probe!.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS * 2);
    expect(probe.calls).toHaveLength(1);
    f.remove();
    await vi.waitFor(() => expect(probe!.calls[0].signal?.aborted).toBe(true));
    await running;
    expect(f.unwatch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.stop.abort();
    probe?.release();
    await running;
  }
});

async function transportFixture() {
  const f = await fixture();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected listener");
  f.saved.url = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const closed: string[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      messages.push(message);
      if (message.type === "hello")
        socket.send(JSON.stringify({ type: "ready", hostId: f.saved.hostId }));
    });
    socket.on("close", (_code, reason) => closed.push(reason.toString()));
  });
  cleanups.push(async () => {
    f.stop.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { ...f, server, sockets, messages, closed };
}

test.each([false, true])(
  "a healthy connection refreshes recovered capability after active work=%s has completed",
  async (activeWork) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = await transportFixture();
    boundary.run.mockRejectedValueOnce(
      new Error("notification service starting"),
    );
    let release: () => void = () => {};
    let operationSignal: AbortSignal | undefined;
    const handler = vi.fn<ToolImplementation>(async (_params, context) => {
      operationSignal = context?.abortSignal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ok: true,
        output: "operation finished",
        producedNewInformation: true,
      };
    });
    const connect = vi.fn((options: NativeSessionOptions) =>
      connectNativeHost({ ...options, handlers: { system_command: handler } }),
    );
    const running = runNativeHostSupervisor({
      ...f,
      connect,
      signal: f.stop.signal,
      reconnectDelayMs: 1,
    });
    try {
      await vi.waitFor(() =>
        expect(
          f.messages.filter((message) => message.type === "hello"),
        ).toHaveLength(1),
      );
      expect(f.messages[0].capabilities).not.toContain(
        DESKTOP_NOTIFICATION_CAPABILITY,
      );
      if (activeWork) {
        f.sockets[0].send(
          JSON.stringify({
            type: "execute",
            id: randomUUID(),
            hostId: f.saved.hostId,
            operation: "system_command",
            params: { target: "linux", cwd: "/tmp", command: "unused" },
          }),
        );
        await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      }
      await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS);
      await vi.waitFor(() =>
        expect(
          boundary.run.mock.calls.some(([input]) => input.file === "gdbus"),
        ).toBe(true),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS);
      if (activeWork) {
        expect(f.closed).toEqual([]);
        expect(operationSignal?.aborted).toBe(false);
        release();
      }
      await vi.waitFor(() =>
        expect(
          f.messages.filter((message) => message.type === "hello"),
        ).toHaveLength(2),
      );
      expect(f.closed).toContain("capabilities_changed");
      const hello = f.messages.filter((message) => message.type === "hello");
      expect(hello[1].capabilities).toContain(DESKTOP_NOTIFICATION_CAPABILITY);
      if (activeWork) {
        expect(f.messages.map((message) => message.type)).toEqual([
          "hello",
          "result",
          "hello",
        ]);
        expect(f.messages[1].result).toMatchObject({
          ok: true,
          output: "operation finished",
        });
        expect(operationSignal?.aborted).toBe(false);
      }
      const probeCount = boundary.run.mock.calls.length;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await vi.advanceTimersByTimeAsync(NATIVE_STATUS_INTERVAL_MS);
      expect(boundary.run).toHaveBeenCalledTimes(probeCount);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      release();
      f.stop.abort();
      await running;
    }
  },
);
