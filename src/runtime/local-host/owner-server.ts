import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { closeHttpServerImmediately } from "../../shared/http-server-shutdown.js";
import type {
  LocalRuntimeEndpoint,
  LocalRuntimeOwner,
  LocalRuntimePeer,
} from "./contracts.js";
import { LocalRuntimeRpcPeer } from "./rpc-peer.js";

export function localRuntimeIdentityHeader(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

export async function startLocalRuntimeOwnerServer(
  identity: string,
  owner: LocalRuntimeOwner,
): Promise<{ endpoint: LocalRuntimeEndpoint; close: () => Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const expectedIdentity = localRuntimeIdentityHeader(identity);
  const peers = new Set<LocalRuntimeRpcPeer>();
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({
    server,
    maxPayload: 64 * 1024 * 1024,
    perMessageDeflate: false,
    verifyClient: ({ req }: { req: IncomingMessage }) =>
      isAuthenticatedLocalClient(req, token, expectedIdentity),
  });
  sockets.on("connection", (socket) => {
    const rpc = new LocalRuntimeRpcPeer(socket);
    const peer: LocalRuntimePeer = Object.freeze({
      id: rpc.id,
      callClient: (method, args) => rpc.call(method, args),
      onClose: (listener) => rpc.onClose(listener),
    });
    rpc.setHandler((method, args) => owner.call(method, args, peer));
    peers.add(rpc);
    rpc.onClose(() => {
      peers.delete(rpc);
    });
  });
  const unsubscribe = owner.subscribe((event) => {
    for (const peer of peers) peer.publish(event);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    unsubscribe();
    sockets.close();
    throw error;
  }
  const endpoint: LocalRuntimeEndpoint = {
    version: 1,
    identity,
    pid: process.pid,
    port: (server.address() as AddressInfo).port,
    token,
  };
  let shutdown: Promise<void> | undefined;
  return {
    endpoint,
    close: () => {
      shutdown ??= closeOwner();
      return shutdown;
    },
  };

  async function closeOwner(): Promise<void> {
    unsubscribe();
    const serverClosed = closeHttpServerImmediately(server, sockets);
    for (const peer of peers) peer.close();
    await Promise.all([owner.stop(), serverClosed]);
  }
}

function isAuthenticatedLocalClient(
  request: IncomingMessage,
  token: string,
  identity: string,
): boolean {
  if (request.socket.remoteAddress !== "127.0.0.1") return false;
  if (request.headers["x-abot-runtime-identity"] !== identity) return false;
  const authorization = request.headers.authorization ?? "";
  const expected = `Bearer ${token}`;
  const observedBytes = Buffer.from(authorization);
  const expectedBytes = Buffer.from(expected);
  if (observedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(observedBytes, expectedBytes);
}
