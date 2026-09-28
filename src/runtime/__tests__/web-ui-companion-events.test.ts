import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import { COMPANION_RELEASE_VERSION } from "../../computer-access/companion/release-version.js";
// @ts-expect-error Browser-only controller has no declaration surface.
import { createPassiveLearningController } from "../../web-ui/app/controllers/passive-learning-controller.js";
import {
  hostCompanionFixture,
  nextHostMessage,
  testHostIdentity,
} from "./support/host-companion-fixture.js";

test("companion reconnect refreshes its version with collection off, including an outdated in-flight read", async () => {
  let backend!: LocalRuntimeWebBackend;
  const fixture = await hostCompanionFixture(() =>
    backend.notifyHostConnectionChanged(),
  );
  backend = new LocalRuntimeWebBackend({
    rootDir: fixture.rootDir,
    defaultEnvironmentId: "dev",
  });
  const status = {
    preferences: { enabled: false },
    state: "off",
    deviceId: "same-computer",
  };
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ status })),
    listPassiveLearningBatches: vi.fn(async () => ({ items: [] })),
    listModels: vi.fn(async () => ({ profiles: [] })),
    getSystemHostConnection: vi.fn(async () => (await fixture.api()).body),
  };
  const controller = createPassiveLearningController({
    client,
    getEnvironmentId: () => "dev",
    render: vi.fn(),
    isVisible: () => true,
  });
  const messages: unknown[] = [];
  const browser = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    send(raw: string) {
      const message = JSON.parse(raw);
      messages.push(message);
      controller.handleRealtime(message);
    },
  });
  backend.handleRealtimeConnection(browser as unknown as WebSocket);
  try {
    const grant = await fixture.pair();
    const activate = async (version: number) => {
      const socket = await fixture.open(grant.credential);
      const ready = nextHostMessage(socket);
      socket.send(
        JSON.stringify({
          type: "hello",
          version: 1,
          identity: testHostIdentity,
          hostId: grant.hostId,
          companionVersion: version,
        }),
      );
      await ready;
      return socket;
    };
    const previous = await activate(1);
    controller.setWorkspace("learning");
    await vi.waitFor(() =>
      expect(
        controller.snapshot().hostConnection?.companion.installedVersion,
      ).toBe(1),
    );
    const staleHost = controller.snapshot().hostConnection;
    let release!: (value: Record<string, unknown>) => void;
    const slowRead = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    client.getSystemHostConnection.mockImplementationOnce(() => slowRead);
    const refreshing = controller.refresh();
    await vi.waitFor(() =>
      expect(client.getSystemHostConnection).toHaveBeenCalledTimes(2),
    );
    previous.terminate();
    await vi.waitFor(async () =>
      expect((await fixture.api()).body.connected).toBe(false),
    );
    await activate(COMPANION_RELEASE_VERSION);
    release(staleHost);
    await refreshing;
    await vi.waitFor(() =>
      expect(
        controller.snapshot().hostConnection?.companion.installedVersion,
      ).toBe(COMPANION_RELEASE_VERSION),
    );
    expect(controller.snapshot().status).toBe(status);
    expect(controller.snapshot().hostConnection.companion.updateAvailable).toBe(
      false,
    );
    expect(messages).toEqual(Array(4).fill({ type: "system-host.changed" }));
  } finally {
    controller.setWorkspace("config");
    browser.emit("close");
    await fixture.close();
    await backend.stop();
  }
});
