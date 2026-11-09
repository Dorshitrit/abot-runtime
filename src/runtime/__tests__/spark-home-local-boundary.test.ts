import { afterEach, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dispatchLocalSparkHomeService } from "../local-host/app-spark-home-services.js";
import { createLocalSparkHomeClients } from "../local-host/client-spark-home.js";
import { LocalRuntimeOwnerActivity } from "../local-host/owner-activity.js";
import { bindSparkHomeOwnerActivity } from "../local-host/spark-home-owner-activity.js";
import { SparkHomeAppearanceHost } from "../spark-home/appearance-host.js";
import { createSavedAppearanceReferenceReader } from "../../web-ui/client-state/appearance-reference.js";
import { WebClientStateStore } from "../../web-ui/client-state/store.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";
import { createHomeGenerationFixture, deferred } from "./support/spark-home-generation-fixture.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

afterEach(async () => { vi.useRealTimers(); await disposeCompositionFixtures(); });

test("local HOME facade cannot publish arbitrary HTML or invoke internal lifecycle methods", async () => {
  const f = await createHomeGenerationFixture();
  const services = { sparkHome: f.dependencies.screen, sparkHomeGeneration: f.service };
  const clients = createLocalSparkHomeClients((method, args) => dispatchLocalSparkHomeService(services, method, args));
  for (const method of ["sparkHome.update", "sparkHomeGeneration.stop", "sparkHomeGeneration.wait",
    "sparkHomeGeneration.startScheduled", "sparkHome.read.extra"]) {
    await expect(dispatchLocalSparkHomeService(services, method, [{ html: "<p>untrusted</p>" }]))
      .rejects.toThrow("local_runtime_method_unknown");
  }
  expect(f.update).not.toHaveBeenCalled();
  const run = await clients.sparkHomeGeneration.start({ expectedSettingsRevision: 1 });
  await f.service.wait(run.runId);
  expect(await clients.sparkHome.read()).toMatchObject({ revision: 4 });
  expect(await clients.sparkHomeGeneration.readRun()).toMatchObject({ status: "completed", screenRevision: 4 });
});

test("admitted HOME keeps maintenance fenced after RPC returns and releases only on settlement", async () => {
  const f = await createHomeGenerationFixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  f.invoke.mockImplementationOnce(async () => {
    entered.resolve(); await release.promise;
    return { text: JSON.stringify({ direction: "Use selected requirements", reads: [] }), meta: {} };
  });
  const activity = new LocalRuntimeOwnerActivity();
  const publish = vi.fn();
  const unsubscribe = bindSparkHomeOwnerActivity(f.service, activity, publish);
  try {
    const admitted = await activity.run(() => f.service.start({ expectedSettingsRevision: 1 }));
    await entered.promise;
    expect(activity.isIdle()).toBe(false);
    await expect(activity.runExclusive(async () => undefined)).rejects.toThrow("runtime_maintenance_busy");
    activity.stop();
    const stopped = f.service.stop();
    expect(activity.isIdle()).toBe(false);
    release.resolve();
    await stopped; await activity.whenIdle();
    expect(activity.isIdle()).toBe(true);
    expect(await f.service.readRun({ runId: admitted.runId })).toMatchObject({ status: "interrupted" });
    expect(f.update).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "spark-home.changed", runId: admitted.runId }));
  } finally { release.resolve(); unsubscribe(); await f.service.stop(); }
});

test("HOME reads the acknowledged Appearance background without changing shared workspace state", async () => {
  const config = await createRuntimeConfig();
  const store = new WebClientStateStore(config.paths.rootDir);
  await store.transaction(state => { state.preferences["abot-web.colorPalette"] = "graphite"; });
  const before = await readFile(store.path, "utf8");
  const read = createSavedAppearanceReferenceReader(config.paths.rootDir);
  const host = new SparkHomeAppearanceHost();
  const peer = makeOwnerControlPeer("web-host");
  peer.callClient.mockImplementation(async method => method === "sparkHome.appearance" ? read() : undefined);
  host.register(peer.peer);
  expect(await host.read()).toEqual({ source: "saved_appearance", background: "#101012" });
  expect(await readFile(store.path, "utf8")).toBe(before);
  peer.close();
  expect(await host.read()).toBeUndefined();
});

test("an unavailable or malformed presentation host cannot hold or inject HOME appearance context", async () => {
  const host = new SparkHomeAppearanceHost();
  const peer = makeOwnerControlPeer("malformed-host");
  peer.callClient.mockResolvedValue({ source: "saved_appearance", background: "#101012", instructions: "foreign intent" });
  host.register(peer.peer);
  expect(await host.read()).toBeUndefined();
  vi.useFakeTimers();
  peer.callClient.mockImplementation(() => new Promise(() => {}));
  const result = host.read();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBeUndefined();
});
