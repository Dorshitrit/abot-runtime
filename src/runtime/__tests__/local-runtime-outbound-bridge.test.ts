import { afterEach, describe, expect, it, vi } from "vitest";
import { startAgentBridge, type AgentBridgeOptions } from "../../bridge/start-agent-bridge.js";
import { validateRuntimeBridgeConnection } from "../../bridge/runtime-connection.js";
import { createLocalRuntimeApplication } from "../local-application.js";
import { LocalRequestControls } from "../local-host/app-request-control.js";
import { createSocketConnectionService } from "../socket-connection/service.js";
import { createLocalOwnerBridge } from "../local-host/app-bridge.js";
import type { LocalRuntimeOwner, LocalRuntimePeer } from "../local-host/contracts.js";
import type { RuntimeConfig } from "../ports.js";
import { createEnvironmentPathsFixture } from "./support/environment-paths-fixture.js";

vi.mock("../../bridge/start-agent-bridge.js", () => ({ startAgentBridge: vi.fn() }));
const open = vi.mocked(startAgentBridge);
const connection = { runtimeId: "alpha", url: "wss://relay.example/agent-bridge", token: "fixture-private-token" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  open.mockReset();
});

function mockTransport() {
  const stop = vi.fn(async () => {});
  open.mockReturnValue({ stop, getStatus: vi.fn() });
  return stop;
}

async function environment() {
  const fixture = await createEnvironmentPathsFixture({ profiles: { alpha: {}, beta: {} } });
  cleanups.push(fixture.dispose);
  return fixture.load("alpha");
}

function client(config: RuntimeConfig, bridge?: typeof connection) {
  const app = createLocalRuntimeApplication(config, { bridge });
  cleanups.push(() => app.stop());
  return app;
}

describe("explicit outbound transport on the shared local owner", () => {
  it("keeps ordinary clients entirely local and attaches a single peer on a paired client's request", async () => {
    const stop = mockTransport();
    const config = { ...await environment(), agentBridgeUrl: connection.url, agentBridgeToken: connection.token };
    const owner = client(config);
    await owner.start();
    expect(open).not.toHaveBeenCalled();
    const paired = client(config, connection), observer = client(config, connection);
    await Promise.all([paired.start(), observer.start()]);
    expect(paired.getOwnership()).toBe("client");
    expect(open).toHaveBeenCalledTimes(1);
    await paired.connectBridge(connection);
    await expect(observer.connectBridge({ ...connection, token: "other-token" })).rejects.toThrow("runtime_bridge_connection_conflict");
    await expect(observer.connectBridge({ ...connection, url: "wss://other.example/" })).rejects.toThrow("runtime_bridge_connection_conflict");
    await expect(observer.connectBridge({ ...connection, runtimeId: "beta" })).rejects.toThrow("runtime_bridge_connection_invalid");
    const options = open.mock.calls[0]![0]!;
    expect(options.runtimeConfig?.paths.runtimeDir).toBe(config.paths.runtimeDir);
    expect(options.token).toBe(connection.token);
    expect(options.requestHandler?.approvalControls).toBeDefined();
    expect(options.requestHandler?.sparkChat).toBeDefined();
    await owner.services.sessions.appendMessage("ordinary", "user", "Fixture input");
    await paired.stop(); await observer.stop();
    expect(stop).not.toHaveBeenCalled();
    expect((await options.sessionStore!.getSessionById("ordinary"))?.messages[0]?.content).toBe("Fixture input");
    expect(await options.agents!.remote({ type: "agents.list.request", allowedModes: ["ask"] })).toMatchObject({ agents: expect.any(Array) });
    await owner.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not let an old approval reconnect activate a replacement owner", async () => {
    const stop = mockTransport(), config = await environment();
    const first = client(config, connection);
    await first.start();
    const previous = client(config, connection);
    await previous.start();
    await first.stop();
    expect(stop).toHaveBeenCalledOnce();

    const next = client(config);
    await next.start();
    expect(next.getOwnership()).toBe("owner");
    await expect(previous.approvals.list()).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1);

    const fresh = client(config, connection);
    await fresh.start();
    await fresh.connectBridge(connection);
    expect(open).toHaveBeenCalledTimes(2);
    expect(await fresh.approvals.list()).toEqual([]);
  });

  it("keeps local startup usable on bridge failure and allows explicit retry with no credential leakage", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    open.mockImplementationOnce(() => { throw new Error(connection.token); });
    const config = await environment(), app = client(config, connection);
    await app.start();
    expect(app.getOwnership()).toBe("owner");
    expect(JSON.stringify(error.mock.calls)).not.toContain(connection.token);
    expect((await app.services.sessions.getSessionById("missing")) == null).toBe(true);
    const stop = mockTransport();
    await app.connectBridge(connection);
    await app.stop();
    expect(stop).toHaveBeenCalledOnce();
    await expect(app.connectBridge(connection)).rejects.toThrow("local_runtime_stopped");
  });

  it("routes events and request authority through the same local peer and releases subscriptions on stop", async () => {
    const stop = mockTransport();
    const config = await environment();
    const router = createLocalOwnerBridge(config);
    const listeners = new Set<(value: unknown) => void>();
    const call = vi.fn(async (_method: string, _args: readonly unknown[], _peer: LocalRuntimePeer) => []);
    const owner: LocalRuntimeOwner = {
      call, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, stop: async () => {},
    };
    router.start(connection, owner);
    const options: AgentBridgeOptions = open.mock.calls[0]![0]!;
    const updated = vi.fn();
    options.subscribeAgentEvents!(updated);
    const raw = { type: "agents.list.request", allowedModes: ["ask"] };
    await options.agents!.remote(raw);
    expect(call).toHaveBeenCalledWith("agents.remote", [raw], expect.objectContaining({ id: "local-outbound-bridge" }));
    await options.sessionStore!.getSessionById("ordinary");
    expect(call).toHaveBeenLastCalledWith("sessions.getSessionById", ["ordinary"], call.mock.calls[0]![2]);
    for (const listener of listeners) {
      listener({ type: "agents.changed", revision: 3, note: "private" });
      listener({ type: "agents.changed", revision: -1 });
      listener({ type: "other", revision: 4 });
    }
    expect(updated.mock.calls).toEqual([[3]]);
    const closing = router.stop();
    expect(listeners.size).toBe(0);
    expect(() => router.start(connection, owner)).toThrow("local_runtime_owner_stopped");
    await Promise.all([closing,router.stop()]);
    expect(stop).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it("fences the old peer during a binding change and reopens it when the write is refused", async () => {
    const stop = mockTransport(), config = await environment();
    const controls = new LocalRequestControls(() => {});
    const bridge = createLocalOwnerBridge(config, peer => controls.hasActivePeer(peer));
    const owner: LocalRuntimeOwner = {
      call: vi.fn(async () => null), subscribe: () => () => {}, stop: async () => {},
    };
    const local: LocalRuntimePeer = {
      id: "web", callClient: async () => null, onClose: () => () => {},
    };
    const current = () => open.mock.calls[0]![0]!.sessionStore!.getSessionById("test");
    let duringWrite: Promise<string> | undefined;
    const service = createSocketConnectionService(config, {
      ...bridge, start: (connection, exact) => bridge.start(connection, owner, exact),
      fence() {
        const release = bridge.fence();
        duringWrite = current().then(() => "routed", (error: Error) => error.message);
        return release;
      },
    });
    cleanups.push(service.stop);
    const other = createSocketConnectionService({ ...config, runtimeId: "beta" });
    cleanups.push(other.stop);
    const bundle = { runtimeId: "alpha", agentBridgeUrl: connection.url, runtimeToken: "x".repeat(43) };
    const held = { ...bundle, runtimeId: "beta" };
    await service.management.import({ bundle, expectedRevision: 0 });
    await other.management.import({ bundle: held, expectedRevision: 0 });
    controls.ordinary("local-work", local, {}, "unrelated-session");
    try {
      await expect(service.management.import({ bundle: held, expectedRevision: 1, confirmBinding: true }))
        .rejects.toThrow("socket_connection_binding_in_use");
      expect(await duringWrite).toBe("socket_connection_busy");
      expect(owner.call).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(await service.management.status()).toMatchObject({ revision: 1, remoteRuntimeId: "alpha" });
      expect(await current()).toBeNull();
      expect(owner.call).toHaveBeenCalledOnce();
      expect(await service.management.pause({ expectedRevision: 1 })).toMatchObject({ state: "paused" });
      expect(controls.hasActivePeer(local)).toBe(true);
      await expect(current()).rejects.toThrow("local_runtime_connection_lost");
    } finally {
      controls.finish("local-work");
    }
  });

  it.each([
    "https://relay.example/agent-bridge",
    "wss://user:secret@relay.example/agent-bridge",
    "wss://relay.example/agent-bridge#fragment",
    "broken",
  ])("rejects unsuitable bridge addresses before dispatch", url => {
    expect(() => validateRuntimeBridgeConnection({ ...connection, url }, "alpha")).toThrow("runtime_bridge_connection_invalid");
    expect(() => validateRuntimeBridgeConnection({ ...connection, token: "a\nb" }, "alpha")).toThrow("runtime_bridge_connection_invalid");
    expect(open).not.toHaveBeenCalled();
  });
});
