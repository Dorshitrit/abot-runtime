import { join } from "node:path";
import { acquireFileLock } from "../adapters/long-term-memory/file-lock/acquisition.js";
import type {
  LocalRuntimeConnection,
  LocalRuntimeConnectionOptions,
} from "./contracts.js";
import {
  ensurePrivateRuntimeDirectory,
  removeLocalRuntimeEndpoint,
  writeLocalRuntimeEndpoint,
} from "./endpoint.js";
import { startLocalRuntimeOwnerServer } from "./owner-server.js";
import { LocalRuntimeRpcPeer } from "./rpc-peer.js";
import { releaseRuntimeOwnerWhenIdle } from "./owner-retirement.js";
import {
  connectToPublishedRuntimeOwner,
  connectToRuntimeOwner,
  waitForRuntimeOwnerElection,
} from "./startup-connection.js";

export type {
  LocalRuntimeCallHandler,
  LocalRuntimeConnection,
  LocalRuntimeConnectionOptions,
  LocalRuntimeOwner,
  LocalRuntimePeer,
} from "./contracts.js";

export async function createLocalRuntimeConnection(
  options: LocalRuntimeConnectionOptions,
): Promise<LocalRuntimeConnection> {
  if (!options.identity) throw new Error("local_runtime_identity_required");
  await ensurePrivateRuntimeDirectory(options.directory);
  const deadline = Date.now() + (options.startupTimeoutMs ?? 10_000);
  for (;;) {
    const release = await tryAcquireRuntimeOwner(options.directory);
    if (release) return establishRuntimeOwner(options, release);
    const peer = await connectToPublishedRuntimeOwner(options, deadline);
    if (peer)
      return createConnection(peer, "client", async () => {
        peer.close();
      });
    await waitForRuntimeOwnerElection(deadline);
  }
}

async function establishRuntimeOwner(
  options: LocalRuntimeConnectionOptions,
  release: () => Promise<void>,
): Promise<LocalRuntimeConnection> {
  let host:
    | Awaited<ReturnType<typeof startLocalRuntimeOwnerServer>>
    | undefined;
  let owner: Awaited<ReturnType<typeof options.createOwner>> | undefined;
  try {
    owner = await options.createOwner();
    host = await startLocalRuntimeOwnerServer(options.identity, owner);
    await writeLocalRuntimeEndpoint(options.directory, host.endpoint);
    const peer = await connectToRuntimeOwner(
      host.endpoint,
      Date.now() + 10_000,
    );
    return createConnection(peer, "owner", async () => {
      try {
        await host!.close();
      } finally {
        try {
          await removeLocalRuntimeEndpoint(
            options.directory,
            host!.endpoint.token,
          );
        } finally {
          await releaseRuntimeOwnerWhenIdle(owner, release);
        }
      }
    });
  } catch (error) {
    try {
      if (host) {
        await host.close();
        await removeLocalRuntimeEndpoint(
          options.directory,
          host.endpoint.token,
        );
      } else await owner?.stop();
    } finally {
      await releaseRuntimeOwnerWhenIdle(owner, release);
    }
    throw error;
  }
}

function createConnection(
  peer: LocalRuntimeRpcPeer,
  ownership: "owner" | "client",
  close: () => Promise<void>,
): LocalRuntimeConnection {
  let shutdown: Promise<void> | undefined;
  return Object.freeze({
    ownership,
    call: (method, args) => peer.call(method, args),
    subscribe: (listener) => peer.subscribe(listener),
    setClientHandler: (handler) => peer.setHandler(handler),
    onClose: (listener) => peer.onClose(listener),
    close: () => {
      shutdown ??= close();
      return shutdown;
    },
  });
}

async function tryAcquireRuntimeOwner(
  directory: string,
): Promise<(() => Promise<void>) | undefined> {
  try {
    return await acquireFileLock(join(directory, "owner"), {
      waitMs: 0,
      releaseMode: "synchronous",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "long_term_memory_store_lock_timeout"
    )
      return undefined;
    throw error;
  }
}
