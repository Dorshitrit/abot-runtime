import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  localRuntimeEndpointPath,
  readLocalRuntimeEndpoint,
} from "../../local-host/endpoint.js";
import { localRuntimeIdentityHeader } from "../../local-host/owner-server.js";
import {
  createLocalRuntimeConnection,
  type LocalRuntimeConnection,
  type LocalRuntimeOwner,
} from "../../local-host/transport.js";

let directory: string;
const connections: LocalRuntimeConnection[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "abot-host-access-"));
});
afterEach(async () => {
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
    await chmod(localRuntimeEndpointPath(directory), 0o600).catch(
      () => undefined,
    );
  }
  for (const connection of connections.splice(0).reverse())
    await connection.close();
  await rm(directory, { recursive: true, force: true });
});

async function connect(
  owner?: LocalRuntimeOwner,
  identity = "same-environment",
) {
  const connection = await createLocalRuntimeConnection({
    directory,
    identity,
    createOwner: async () =>
      owner ?? {
        call: async (_method, args) => args,
        subscribe: () => () => {},
        stop: async () => {},
      },
  });
  connections.push(connection);
  return connection;
}

test("a live owner with different identity fails before constructing another application", async () => {
  await connect();
  const createOwner = vi.fn();
  await expect(
    createLocalRuntimeConnection({
      directory,
      identity: "different",
      createOwner,
    }),
  ).rejects.toThrow("local_runtime_identity_mismatch");
  expect(createOwner).not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32")(
  "private directory and endpoint permissions are enforced before attaching",
  async () => {
    await connect();
    const path = localRuntimeEndpointPath(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o644);
    await expect(connect()).rejects.toThrow(
      "local_runtime_endpoint_not_private",
    );
    await chmod(path, 0o600);
    await chmod(directory, 0o755);
    await expect(connect()).rejects.toThrow(
      "local_runtime_directory_not_private",
    );
  },
);

test("tampered authentication token is rejected without creating a replacement owner", async () => {
  const owner = await connect();
  const endpoint = (await readLocalRuntimeEndpoint(directory))!;
  const path = localRuntimeEndpointPath(directory);
  const original = await readFile(path, "utf8");
  await writeFile(path, JSON.stringify({ ...endpoint, token: "0".repeat(64) }));
  try {
    await expect(connect()).rejects.toThrow("401");
  } finally {
    await writeFile(path, original);
  }
  expect(await owner.call("echo", ["authenticated"])).toEqual([
    "authenticated",
  ]);
});

test("failed owner creation releases ownership so a later explicit startup can succeed", async () => {
  await expect(
    createLocalRuntimeConnection({
      directory,
      identity: "same-environment",
      createOwner: async () => {
        throw new Error("owner_initialization_failed");
      },
    }),
  ).rejects.toThrow("owner_initialization_failed");
  expect((await connect()).ownership).toBe("owner");
});

test("remote errors preserve public name, code and exact message without a remote stack", async () => {
  await connect({
    call: async () => {
      throw Object.assign(new Error("This session was deleted."), {
        name: "SessionDeletedError",
        code: "session_deleted",
      });
    },
    subscribe: () => () => {},
    stop: async () => {},
  });
  const follower = await connect();
  await expect(follower.call("session.append")).rejects.toMatchObject({
    name: "SessionDeletedError",
    code: "session_deleted",
    message: "This session was deleted.",
  });
});

test("peer loss rejects reverse callbacks and invokes close observers exactly once", async () => {
  const disconnected = vi.fn();
  let callbackRequested: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    callbackRequested = resolve;
  });
  let callbackFailed: (error: unknown) => void = () => {};
  const failed = new Promise<unknown>((resolve) => {
    callbackFailed = resolve;
  });
  await connect({
    call: async (_method, _args, peer) => {
      peer.onClose(disconnected);
      callbackRequested();
      try {
        return await peer.callClient("pending", []);
      } catch (error) {
        callbackFailed(error);
        throw error;
      }
    },
    subscribe: () => () => {},
    stop: async () => {},
  });
  const follower = await connect();
  const connectionClosed = vi.fn();
  follower.onClose(connectionClosed);
  follower.setClientHandler(async () => new Promise(() => {}));
  const pending = follower.call("callback");
  const rejected = expect(pending).rejects.toThrow(
    "local_runtime_connection_lost",
  );
  await requested;
  await follower.close();
  await rejected;
  expect(await failed).toMatchObject({
    message: "local_runtime_connection_lost",
  });
  expect(disconnected).toHaveBeenCalledTimes(1);
  expect(connectionClosed).toHaveBeenCalledTimes(1);
  const alreadyClosed = vi.fn();
  follower.onClose(alreadyClosed);
  expect(alreadyClosed).toHaveBeenCalledTimes(1);
});

test("text frames cannot invoke an authenticated owner's dispatcher", async () => {
  const call = vi.fn(async () => true);
  await connect({ call, subscribe: () => () => {}, stop: async () => {} });
  const endpoint = (await readLocalRuntimeEndpoint(directory))!;
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}`, {
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      "x-abot-runtime-identity": localRuntimeIdentityHeader(endpoint.identity),
    },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  socket.send(
    JSON.stringify({
      kind: "call",
      id: "unexpected",
      method: "execute",
      args: [],
    }),
  );
  await closed;
  expect(call).not.toHaveBeenCalled();
});
