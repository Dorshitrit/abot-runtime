import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalRuntimeOwnerServer } from "../../local-host/owner-server.js";
import { connectToRuntimeOwner } from "../../local-host/startup-connection.js";
import { createReconnectableRuntimeConnection } from "../../local-host/reconnectable-connection.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const call = vi.fn(async (method, args, peer) => {
    if (method === "callback") return peer.callClient("callback", args);
    return args;
  });
  const owner = await startLocalRuntimeOwnerServer("approval-environment", {
    call,
    subscribe: () => () => {},
    stop: async () => {},
  });
  cleanups.push(() => owner.close());
  const peer = await connectToRuntimeOwner(owner.endpoint, Date.now() + 10_000);
  const connection = createReconnectableRuntimeConnection(
    peer,
    owner.endpoint,
    "client",
  );
  cleanups.push(() => connection.close());
  return { owner, peer, connection, call };
}

describe("explicit approval connection attachment", () => {
  it("reconnects only on an explicit call and preserves handlers without replaying earlier calls", async () => {
    const { peer, connection, call } = await fixture();
    const handler = vi.fn(async (_method, args) => args);
    const closed = vi.fn();
    connection.setClientHandler(handler);
    connection.onClose(closed);
    expect(await connection.call("first", ["once"])).toEqual(["once"]);
    peer.close();
    await expect(connection.call("failed", [])).rejects.toThrow(
      "local_runtime_connection_lost",
    );
    expect(closed).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledTimes(1);
    await Promise.all([connection.reconnect(), connection.reconnect()]);
    expect(await connection.call("callback", ["restored"])).toEqual([
      "restored",
    ]);
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "first",
      "callback",
    ]);
    expect(handler).toHaveBeenCalledExactlyOnceWith("callback", ["restored"]);
  });

  it("fails when the captured owner is gone and never creates a replacement", async () => {
    const { owner, connection, call } = await fixture();
    const disconnected = new Promise<void>((resolve) =>
      connection.onClose(resolve),
    );
    await owner.close();
    await disconnected;
    await expect(connection.reconnect()).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("cannot reconnect after explicit client close", async () => {
    const { connection } = await fixture();
    await connection.close();
    await expect(connection.reconnect()).rejects.toThrow(
      "local_runtime_stopped",
    );
  });
});
