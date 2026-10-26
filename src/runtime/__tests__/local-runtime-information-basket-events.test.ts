import { afterEach, expect, test, vi } from "vitest";
import { createLocalRuntimeApplication } from "../local-application.js";
import type { LocalRuntimeConnection } from "../local-host/contracts.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

vi.mock("../local-host/transport.js", () => ({
  createLocalRuntimeConnection: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.mocked(createLocalRuntimeConnection).mockReset();
});

async function fixture() {
  const runtime = await createSchedulerRuntimeFixture();
  await runtime.application.stop();
  cleanups.push(runtime.dispose);
  let disconnected = false;
  const closeObservers = new Set<() => void>();
  const events = new Set<(event: unknown) => void>();
  const reconnect = vi.fn(async () => {
    const changed = disconnected;
    disconnected = false;
    return changed;
  });
  const connection: LocalRuntimeConnection = {
    ownership: "owner",
    call: async () => [],
    reconnect,
    subscribe(listener) { events.add(listener); return () => { events.delete(listener); }; },
    setClientHandler: () => {},
    onClose(listener) { closeObservers.add(listener); return () => { closeObservers.delete(listener); }; },
    close: async () => {},
    isOwnerIdle: () => true,
    closeIfIdle: async () => true,
  };
  vi.mocked(createLocalRuntimeConnection).mockResolvedValue(connection);
  const application = createLocalRuntimeApplication(runtime.config);
  cleanups.push(() => application.stop());
  await application.start();
  return {
    application, reconnect,
    loseTransport() {
      disconnected = true;
      for (const listener of closeObservers) listener();
    },
    changed() {
      for (const listener of events) listener({ type: "information-basket.changed" });
    },
  };
}

test("the original basket observer survives explicit same-owner reconnection without resubscribing", async () => {
  const f = await fixture();
  const changed = vi.fn();
  const unsubscribe = f.application.subscribeInformationBasketEvents(changed);
  f.changed();
  expect(changed).toHaveBeenCalledTimes(1);

  f.loseTransport();
  await f.application.approvals.list();
  expect(f.reconnect).toHaveBeenCalledOnce();
  f.changed();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(createLocalRuntimeConnection).toHaveBeenCalledOnce();

  unsubscribe();
  f.changed();
  expect(changed).toHaveBeenCalledTimes(2);
});

test.each(["stop", "stopIfIdle"] as const)("%s releases basket observers after reconnect", async (shutdown) => {
  const f = await fixture();
  const changed = vi.fn();
  f.application.subscribeInformationBasketEvents(changed);
  f.loseTransport();
  await f.application.approvals.list();
  f.changed();
  expect(changed).toHaveBeenCalledOnce();

  await f.application[shutdown]();
  f.changed();
  expect(changed).toHaveBeenCalledOnce();
});
