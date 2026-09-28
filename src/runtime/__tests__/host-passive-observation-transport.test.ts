import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { HostConnection } from "../../computer-access/companion/connection.js";
import { HostPairingStore } from "../../computer-access/companion/pairing-store.js";
import { startHostBroker } from "../../computer-access/companion/broker-server.js";
import { readBrokerLocation } from "../../computer-access/companion/broker-location.js";
import { connectHostObservations } from "../../computer-access/companion/observation-client.js";
import { connectNativeHost } from "../../computer-access/companion/native-session.js";
import { executeHostOperation } from "../../computer-access/companion/broker-client.js";
import type { PassiveCollectorEvent } from "../../shared/passive-observation.js";

const dispose: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of dispose.reverse()) await close();
  dispose.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test.each(["linux", "darwin"] as const)("%s authenticated desktop observations traverse the broker and stop on unsubscribe while tools keep working", async (platform) => {
  const rootDir = await mkdtemp(join(tmpdir(), "abot-observation-transport-"));
  dispose.push(() => rm(rootDir, { recursive: true, force: true }));
  vi.stubGlobal("process", { ...process, platform });
  if (platform === "darwin")
    vi.stubEnv("TMPDIR", join(rootDir, "mac-launch-temporary-directory-".repeat(5)));
  const store = new HostPairingStore(rootDir);
  const identity = {
    name: "Fixture desktop",
    os: platform === "darwin" ? "macos" as const : "linux" as const,
    user: "fixture",
    homeDir: "/home/fixture",
  };
  const grant = store.consume(store.begin().code, identity);
  const connection = new HostConnection(store);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket, request) =>
    connection.accept(socket, request.headers.authorization!.slice(7)),
  );
  dispose.push(async () => {
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const broker = await startHostBroker(
    rootDir,
    connection,
    async () => async () => {},
  );
  const socketDirectory = dirname(readBrokerLocation(rootDir)!.socketPath);
  dispose.push(async () => {
    await broker.close();
    await rm(socketDirectory, { recursive: true, force: true });
  });
  const abort = new AbortController();
  let emit!: (event: PassiveCollectorEvent) => void;
  const stopCollector = vi.fn();
  const startCollector = vi.fn((options) => {
    emit = options.onEvent;
    return { close: stopCollector };
  });
  const address = server.address();
  if (typeof address === "string" || address === null)
    throw new Error("missing port");
  const native = connectNativeHost({
    url: `http://127.0.0.1:${address.port}`,
    identity,
    hostId: grant.hostId,
    authorization: grant.credential,
    signal: abort.signal,
    onPaired: async () => {},
    onReady: () => {},
    observationCollector: startCollector,
    handlers: {
      system_targets: async () => ({
        ok: true,
        output: "fixture target",
        producedNewInformation: true,
      }),
    },
  });
  dispose.push(async () => {
    abort.abort();
    await native;
  });
  await vi.waitFor(() => expect(connection.status().connected).toBe(true));
  expect(startCollector).not.toHaveBeenCalled();
  const events = vi.fn();
  const subscription = await connectHostObservations({
    rootDir,
    ownerId: "dev",
    leaseId: randomUUID(),
    abortSignal: abort.signal,
    onEvent: events,
  });
  await vi.waitFor(() => expect(startCollector).toHaveBeenCalledOnce());
  emit({ type: "status", state: "partial", reason: "fixture_coverage" });
  await vi.waitFor(() =>
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: grant.hostId,
        ownerId: "dev",
        state: "partial",
      }),
    ),
  );
  await expect(
    connectHostObservations({
      rootDir,
      ownerId: "prod",
      leaseId: randomUUID(),
      abortSignal: abort.signal,
      onEvent: vi.fn(),
    }),
  ).rejects.toThrow("already_owned");
  const status = connection.status();
  if (!status.connected) throw new Error("lost connection");
  expect(
    await executeHostOperation(rootDir, {
      hostId: grant.hostId,
      connectionId: status.connectionId,
      operation: "system_targets",
      params: {},
    }),
  ).toMatchObject({ ok: true });
  subscription.close();
  await vi.waitFor(() => expect(stopCollector).toHaveBeenCalledOnce());
  expect(connection.status().connected).toBe(true);
});

test("old v1 companion remains usable without receiving observation controls", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "abot-old-observation-"));
  dispose.push(() => rm(rootDir, { recursive: true, force: true }));
  const store = new HostPairingStore(rootDir);
  const identity = {
    name: "Old desktop",
    os: "linux" as const,
    user: "fixture",
    homeDir: "/home/fixture",
  };
  const grant = store.consume(store.begin().code, identity);
  const connection = new HostConnection(store);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) =>
    connection.accept(socket, grant.credential),
  );
  dispose.push(async () => {
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("missing port");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  dispose.push(async () => {
    client.terminate();
  });
  await new Promise<void>((resolve) => client.once("open", resolve));
  client.send(
    JSON.stringify({
      type: "hello",
      version: 1,
      identity,
      hostId: grant.hostId,
    }),
  );
  await vi.waitFor(() => expect(connection.status().connected).toBe(true));
  expect(() =>
    connection.observations.subscribe({
      ownerId: "dev",
      leaseId: randomUUID(),
      onEvent: vi.fn(),
    }),
  ).toThrow("unsupported");
  expect(connection.status().connected).toBe(true);
});
