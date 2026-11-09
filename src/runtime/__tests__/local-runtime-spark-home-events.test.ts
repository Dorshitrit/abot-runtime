import { afterEach, expect, test, vi } from "vitest";
import { createLocalRuntimeApplication } from "../local-application.js";
import type { LocalRuntimeConnection } from "../local-host/contracts.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import { createLocalSparkHomeEvents } from "../local-host/client-spark-home-events.js";
import { createSparkHomeChangeNotifier } from "../../web-ui/local-runtime/spark-home-notifications.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

vi.mock("../local-host/transport.js", () => ({ createLocalRuntimeConnection: vi.fn() }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await disposeCompositionFixtures();
  vi.mocked(createLocalRuntimeConnection).mockReset();
});

async function fixture() {
  const config = await createRuntimeConfig();
  let disconnected = false;
  const closeObservers = new Set<() => void>();
  const events = new Set<(event: unknown) => void>();
  const reconnect = vi.fn(async () => { const changed = disconnected; disconnected = false; return changed; });
  const connection: LocalRuntimeConnection = {
    ownership: "owner", call: async () => [], reconnect,
    subscribe(listener) { events.add(listener); return () => { events.delete(listener); }; },
    setClientHandler: () => {},
    onClose(listener) { closeObservers.add(listener); return () => { closeObservers.delete(listener); }; },
    close: async () => {}, isOwnerIdle: () => true, closeIfIdle: async () => true,
  };
  vi.mocked(createLocalRuntimeConnection).mockResolvedValue(connection);
  const application = createLocalRuntimeApplication(config);
  cleanups.push(() => application.stop());
  await application.start();
  return { application, reconnect,
    emit(event: unknown) { for (const listener of events) listener(event); },
    disconnect() { disconnected = true; for (const listener of closeObservers) listener(); },
  };
}

test("HOME invalidations reach the Web environment without passing through ordinary request events", async () => {
  const f = await fixture();
  const broadcast = vi.fn();
  const notifier = createSparkHomeChangeNotifier({ broadcast });
  const ordinary = vi.fn();
  f.application.subscribeScheduledEvents(ordinary);
  const unsubscribe = f.application.subscribeSparkHomeEvents(change => notifier("dev", change));
  f.emit({ type: "spark-home.changed", runId: "home-run", revision: 3, html: "MUST_NOT_FORWARD", pendingApproval: "PRIVATE" });
  expect(broadcast).toHaveBeenCalledExactlyOnceWith({ type: "spark_home_changed", environmentId: "dev", runId: "home-run", revision: 3 });
  expect(ordinary).not.toHaveBeenCalled();
  f.emit({ type: "learning.changed", runId: "other", revision: 4 });
  f.emit({ type: "spark-home.changed", runId: "home-run", revision: -1 });
  expect(broadcast).toHaveBeenCalledOnce();
  unsubscribe(); f.emit({ type: "spark-home.changed", runId: "home-run", revision: 4 });
  expect(broadcast).toHaveBeenCalledOnce();
});

test.each(["stop", "stopIfIdle"] as const)("HOME observers survive same-owner reconnect and release on %s", async shutdown => {
  const f = await fixture();
  const changed = vi.fn(); f.application.subscribeSparkHomeEvents(changed);
  f.disconnect(); await f.application.approvals.list();
  expect(f.reconnect).toHaveBeenCalledOnce();
  f.emit({ type: "spark-home.changed", runId: "home-run", revision: 3 });
  expect(changed).toHaveBeenCalledOnce();
  await f.application[shutdown]();
  f.emit({ type: "spark-home.changed", runId: "home-run", revision: 4 });
  expect(changed).toHaveBeenCalledOnce();
});

test("an invalidation listener or disconnected browser cannot prevent other HOME observers", () => {
  const client = createLocalSparkHomeEvents();
  client.subscribe(() => { throw new Error("view detached"); });
  const second = vi.fn(); client.subscribe(second);
  client.receive({ type: "spark-home.changed", runId: "run", revision: 1 });
  expect(second).toHaveBeenCalledExactlyOnceWith({ runId: "run", revision: 1 });
  const notify = createSparkHomeChangeNotifier({ broadcast: () => { throw new Error("connection closed"); } });
  expect(() => notify("dev", { runId: "run", revision: 1 })).not.toThrow();
});
