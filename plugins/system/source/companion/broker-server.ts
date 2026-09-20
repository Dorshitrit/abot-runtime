import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { HostConnection } from "./connection.js";
import {
  createBrokerLocation,
  publishBrokerLocation,
  releaseBrokerLocation,
} from "./broker-location.js";
import {
  HOST_WIRE_MAX_BYTES,
  isHostIdentifier,
  isHostOperation,
  isHostRecord,
} from "./protocol.js";

function hasBrokerAuthorization(
  input: Record<string, unknown>,
  token: string,
): boolean {
  if (typeof input.token !== "string") return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(input.token), digest(token));
}
function brokerFailure(error: string) {
  return { ok: false, error };
}
async function dispatchBrokerRequest(
  input: unknown,
  connection: HostConnection,
  token: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (!isHostRecord(input)) return brokerFailure("invalid_host_request");
  if (!hasBrokerAuthorization(input, token))
    return brokerFailure("host_not_authorized");
  if (input.version !== 1)
    return brokerFailure("host_protocol_version_mismatch");
  if (input.kind === "status") return { ok: true, status: connection.status() };
  if (input.kind !== "execute") return brokerFailure("invalid_host_operation");
  if (!isHostIdentifier(input.hostId))
    return brokerFailure("invalid_host_identity");
  if (!isHostIdentifier(input.connectionId))
    return brokerFailure("invalid_host_connection");
  if (!isHostOperation(input.operation))
    return brokerFailure("invalid_host_operation");
  if (!isHostRecord(input.params)) return brokerFailure("invalid_host_params");
  return {
    ok: true,
    result: await connection.execute({
      hostId: input.hostId,
      connectionId: input.connectionId,
      operation: input.operation,
      params: input.params,
      abortSignal: signal,
    }),
  };
}
function serveBrokerSocket(
  socket: Socket,
  connection: HostConnection,
  token: string,
): void {
  const abort = new AbortController();
  let received = Buffer.alloc(0);
  let submitted = false;
  const deadline = setTimeout(() => socket.destroy(), 5_000);
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    clearTimeout(deadline);
    abort.abort();
  });
  socket.on("data", (chunk: Buffer) => {
    if (submitted) {
      socket.destroy();
      return;
    }
    received = Buffer.concat([received, chunk]);
    if (received.length > HOST_WIRE_MAX_BYTES) {
      socket.destroy();
      return;
    }
    const boundary = received.indexOf(10);
    if (boundary < 0) return;
    if (boundary !== received.length - 1) {
      socket.destroy();
      return;
    }
    submitted = true;
    clearTimeout(deadline);
    let input: unknown;
    try {
      input = JSON.parse(received.subarray(0, boundary).toString());
    } catch {
      socket.destroy();
      return;
    }
    void dispatchBrokerRequest(input, connection, token, abort.signal).then(
      (result) => {
        if (!socket.destroyed) socket.end(JSON.stringify(result) + "\n");
      },
      () => {
        if (!socket.destroyed)
          socket.end(
            JSON.stringify(brokerFailure("host_request_failed")) + "\n",
          );
      },
    );
  });
}
export async function startHostBroker(
  rootDir: string,
  connection: HostConnection,
  acquireOwnership: () => Promise<() => Promise<void>>,
): Promise<{ close(): Promise<void> }> {
  const releaseOwnership = await acquireOwnership();
  let owner: ReturnType<typeof createBrokerLocation>;
  try {
    owner = createBrokerLocation(rootDir);
  } catch (error) {
    await releaseOwnership();
    throw error;
  }
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    serveBrokerSocket(socket, connection, owner.token);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(owner.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    publishBrokerLocation(rootDir, owner);
  } catch (error) {
    await closeBrokerListener(server);
    await releaseOwnership();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        try {
          releaseBrokerLocation(rootDir, owner);
        } finally {
          await closeBrokerListener(server);
          await releaseOwnership();
        }
      })();
      return closing;
    },
  };
}

async function closeBrokerListener(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
