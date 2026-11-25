import { join } from "node:path";
import { requireCurrentProcessOwnerIdentity } from "../../computer-access/companion/process-owner-identity.js";
import type { RuntimeBridgeConnection } from "../../bridge/runtime-connection.js";
import type { RuntimeConfig } from "../ports.js";
import { resolveLocalRuntimeIdentity } from "../local-host/client-identity.js";
import { ensurePrivateRuntimeDirectory } from "../local-host/private-directory.js";
import { connectToPublishedRuntimeOwner, waitForRuntimeOwnerElection } from "../local-host/startup-connection.js";
import { tryAcquireRuntimeOwner } from "../local-host/transport.js";
import { socketConnectionClient, type SocketConnectionManagement } from "./contracts.js";
import { createSocketConnectionService } from "./service.js";

/** CLI management never starts an environment or replays a command that crossed IPC. */
export async function withSocketConnectionManagement<T>(config: RuntimeConfig,
  operation: (management: SocketConnectionManagement) => Promise<T>, legacyConnection?: RuntimeBridgeConnection): Promise<T> {
  const directory = join(config.paths.runtimeDir, "local-host");
  const identity = resolveLocalRuntimeIdentity(config);
  const ownerIdentity = await requireCurrentProcessOwnerIdentity();
  await ensurePrivateRuntimeDirectory(directory);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const release = await tryAcquireRuntimeOwner(directory, ownerIdentity);
    if (release) {
      const service = createSocketConnectionService(config, undefined, legacyConnection);
      try { return await operation(service.management); }
      finally { try { await service.stop(); } finally { await release(); } }
    }
    const connection = await connectToPublishedRuntimeOwner({ directory, identity }, deadline);
    if (connection) {
      try { return await operation(socketConnectionClient((method, args) => connection.peer.call(method, args))); }
      finally { connection.peer.close(); }
    }
    await waitForRuntimeOwnerElection(deadline);
  }
}
