import WebSocket from "ws";
import type {
  LocalRuntimeConnectionOptions,
  LocalRuntimeEndpoint,
} from "./contracts.js";
import {
  isLocalRuntimeProcessAlive,
  readLocalRuntimeEndpoint,
} from "./endpoint.js";
import { localRuntimeIdentityHeader } from "./owner-server.js";
import { LocalRuntimeRpcPeer } from "./rpc-peer.js";

export async function connectToPublishedRuntimeOwner(
  options: Pick<LocalRuntimeConnectionOptions, "directory" | "identity">,
  deadline: number,
): Promise<LocalRuntimeRpcPeer | undefined> {
  const endpoint = await readLocalRuntimeEndpoint(options.directory);
  if (!endpoint) return undefined;
  if (!isLocalRuntimeProcessAlive(endpoint.pid)) return undefined;
  assertRuntimeOwnerIdentity(endpoint, options.identity);
  try {
    return await connectToRuntimeOwner(endpoint, deadline);
  } catch (error) {
    if (!isTransientRuntimeOwnerHandshakeFailure(error)) throw error;
    return undefined;
  }
}

export async function waitForRuntimeOwnerElection(
  deadline: number,
): Promise<void> {
  assertRuntimeOwnerStartupTimeRemaining(deadline);
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(25, deadline - Date.now())),
  );
  assertRuntimeOwnerStartupTimeRemaining(deadline);
}

export async function connectToRuntimeOwner(
  endpoint: LocalRuntimeEndpoint,
  deadline: number,
): Promise<LocalRuntimeRpcPeer> {
  assertRuntimeOwnerStartupTimeRemaining(deadline);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}`, {
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "x-abot-runtime-identity": localRuntimeIdentityHeader(
          endpoint.identity,
        ),
      },
      handshakeTimeout: Math.max(1, deadline - Date.now()),
      maxPayload: 64 * 1024 * 1024,
      perMessageDeflate: false,
    });
    const peer = new LocalRuntimeRpcPeer(socket);
    const failed = (error: Error) => {
      peer.close();
      reject(error);
    };
    socket.once("error", failed);
    socket.once("open", () => {
      socket.removeListener("error", failed);
      resolve(peer);
    });
  });
}

function assertRuntimeOwnerIdentity(
  endpoint: LocalRuntimeEndpoint,
  identity: string,
): void {
  if (endpoint.identity !== identity)
    throw new Error("local_runtime_identity_mismatch");
}

function assertRuntimeOwnerStartupTimeRemaining(deadline: number): void {
  if (Date.now() >= deadline)
    throw new Error("local_runtime_owner_start_timeout");
}

function isTransientRuntimeOwnerHandshakeFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!("code" in error)) return false;
  switch (error.code) {
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EPIPE":
    case "ETIMEDOUT":
      return true;
    default:
      return false;
  }
}
