import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  readLocalRuntimeEndpoint,
  writeLocalRuntimeEndpoint,
} from "../../local-host/endpoint.js";
import {
  createLocalRuntimeConnection,
  type LocalRuntimeConnection,
} from "../../local-host/transport.js";
import { TransportProcess } from "./transport-process.js";

let directory: string;
const children: TransportProcess[] = [];
const connections: LocalRuntimeConnection[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "abot-host-startup-"));
});
afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close();
  await Promise.all(children.splice(0).map((child) => child.kill()));
  await rm(directory, { recursive: true, force: true });
});

async function startHandshakeOwner(mode: "exit" | "reset" | "reject") {
  const owner = new TransportProcess(
    directory,
    mode,
    new URL("./startup-owner-worker.ts", import.meta.url),
  );
  children.push(owner);
  await owner.ready();
  return owner;
}

function replacementOwner() {
  return {
    call: async () => process.pid,
    subscribe: () => () => {},
    stop: async () => {},
  };
}

test("startup elects a replacement when the live owner exits during the WebSocket handshake", async () => {
  const initialOwner = await startHandshakeOwner("exit");
  const createOwner = vi.fn(async () => replacementOwner());
  const connection = await createLocalRuntimeConnection({
    directory,
    identity: "test-environment",
    startupTimeoutMs: 3000,
    createOwner,
  });
  connections.push(connection);
  await initialOwner.waitFor((message) => message.kind === "handshake");
  expect(connection.ownership).toBe("owner");
  expect(createOwner).toHaveBeenCalledTimes(1);
  expect(await connection.call("ownerPid")).toBe(process.pid);
}, 10_000);

test("repeated pre-handshake connection loss remains bounded by the initial startup deadline", async () => {
  const initialOwner = await startHandshakeOwner("reset");
  const createOwner = vi.fn(async () => replacementOwner());
  const startedAt = Date.now();
  await expect(
    createLocalRuntimeConnection({
      directory,
      identity: "test-environment",
      startupTimeoutMs: 250,
      createOwner,
    }),
  ).rejects.toThrow("local_runtime_owner_start_timeout");
  expect(Date.now() - startedAt).toBeLessThan(2000);
  expect(
    initialOwner.messages.filter((message) => message.kind === "handshake")
      .length,
  ).toBeGreaterThan(1);
  expect(createOwner).not.toHaveBeenCalled();
}, 10_000);

test("authentication failure stops startup after one handshake without a replacement owner", async () => {
  const initialOwner = await startHandshakeOwner("reject");
  const createOwner = vi.fn(async () => replacementOwner());
  await expect(
    createLocalRuntimeConnection({
      directory,
      identity: "test-environment",
      startupTimeoutMs: 1000,
      createOwner,
    }),
  ).rejects.toThrow("401");
  await initialOwner.waitFor((message) => message.kind === "handshake");
  expect(
    initialOwner.messages.filter((message) => message.kind === "handshake"),
  ).toHaveLength(1);
  expect(createOwner).not.toHaveBeenCalled();
}, 10_000);

test("invalid endpoint configuration fails before a handshake or replacement owner", async () => {
  const initialOwner = await startHandshakeOwner("reset");
  const endpoint = (await readLocalRuntimeEndpoint(directory))!;
  await writeLocalRuntimeEndpoint(directory, { ...endpoint, port: 0 });
  const createOwner = vi.fn(async () => replacementOwner());
  await expect(
    createLocalRuntimeConnection({
      directory,
      identity: "test-environment",
      startupTimeoutMs: 1000,
      createOwner,
    }),
  ).rejects.toThrow("local_runtime_invalid_endpoint");
  expect(
    initialOwner.messages.filter((message) => message.kind === "handshake"),
  ).toHaveLength(0);
  expect(createOwner).not.toHaveBeenCalled();
}, 10_000);
