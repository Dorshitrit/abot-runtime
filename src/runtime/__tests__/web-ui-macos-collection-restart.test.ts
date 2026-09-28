import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only feature.
import { createPassiveLearningFeature } from "../../web-ui/app/passive-learning-feature.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function blockedStatus() {
  return {
    preferences: { enabled: true, processingPaused: true, modelProfileId: "local",
      proactiveEnabled: false, excludedApplications: ["private-app"],
      analysisIntervalMinutes: 15, maxConcurrentBatches: 1 },
    state: "permission_required", reason: "macos_accessibility_permission_timeout",
    collectionState: "permission_required", collectionReason: "macos_accessibility_permission_timeout",
    deviceId: "mac-1", pendingObservations: 3, processing: false,
    activeBatches: 0, recentMemories: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(workspace = "home", os = "macos", initial = blockedStatus()) {
  vi.stubGlobal("document", { visibilityState: "visible" });
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const home = document.createElement("section"), spark = document.createElement("section");
  document.body.append(home); document.body.append(spark);
  let environment = "dev", status = initial;
  const host = { paired: true, connected: true, hostId: "mac-1", connectionId: "socket-1",
    identity: { os, name: "Test Mac", homeDir: "/fixture/test" },
    companion: { installedVersion: 6, updateAvailable: false }, readiness: { ready: true } };
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ ok: true, status })),
    getSystemHostConnection: vi.fn(async () => host),
    listPassiveLearningBatches: vi.fn(async () => ({ items: [] })),
    listPassiveLearningCandidates: vi.fn(async () => ({ items: [] })),
    listModels: vi.fn(async () => ({ profiles: [{ id: "local", label: "Local" }] })),
    configurePassiveLearning: vi.fn(),
    clearPassiveLearningPending: vi.fn(),
    restartPassiveLearningCollection: vi.fn(async (_environment: string) => {
      status = { ...status, state: "starting", reason: "", collectionState: "starting", collectionReason: "" };
      return { ok: true, status };
    }),
  };
  const feature = createPassiveLearningFeature({ client, getEnvironmentId: () => environment,
    learningRoot: spark, openLearning: vi.fn(), showActivityMemories: vi.fn(), openComputerAccess: vi.fn() });
  feature.mountHome(home); feature.setWorkspace(workspace);
  await vi.waitFor(() => expect(feature.snapshot().hostConnection).toEqual(host));
  return { home, spark, feature, client, host,
    notice: (root = workspace === "home" ? home : spark) => root.querySelector("[data-learning-mac-restart]")!,
    button: (root = workspace === "home" ? home : spark) => root.querySelector("[data-learning-restart-collection]")!,
    setStatus: (next: ReturnType<typeof blockedStatus>) => { status = next; },
    changeEnvironment: () => { environment = "prod"; feature.environmentChanged(); },
    changeEnvironmentWithoutRefresh: () => { environment = "prod"; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Mac collection restart across Home and Spark", () => {
  test.each(["home", "learning"])("%s restarts the collection owner once without changing preferences or pending work", async (workspace) => {
    const f = await fixture(workspace);
    const before = structuredClone(f.feature.snapshot().status);
    expect(f.notice().hidden).toBe(false);
    f.button().dispatch("click");
    await vi.waitFor(() => expect(f.client.restartPassiveLearningCollection).toHaveBeenCalledExactlyOnceWith("dev"));
    await vi.waitFor(() => expect(f.feature.snapshot().saving).toBe(false));
    expect(f.feature.snapshot().status.preferences).toEqual(before.preferences);
    expect(f.feature.snapshot().status.pendingObservations).toBe(3);
    expect(f.client.configurePassiveLearning).not.toHaveBeenCalled();
    expect(f.client.clearPassiveLearningPending).not.toHaveBeenCalled();
    expect(f.notice(f.home).hidden).toBe(true);
    expect(f.notice(f.spark).hidden).toBe(true);
  });

  test.each(["macos_accessibility_permission_required", "macos_accessibility_permission_revoked"])("shows the collection reason %s even when processing has another status", async (reason) => {
    const status = { ...blockedStatus(), state: "failed", reason: "learning_model_required", collectionReason: reason };
    const f = await fixture("home", "macos", status);
    expect(f.notice().hidden).toBe(false);
  });

  test.each(["non-Mac", "healthy", "off", "unrelated permission"])("hides the action for %s and prevents programmatic hidden clicks", async (kind) => {
    const status = blockedStatus();
    if (kind === "healthy") status.collectionState = "partial";
    if (kind === "off") status.preferences.enabled = false;
    if (kind === "unrelated permission") status.collectionReason = "different_permission";
    const f = await fixture("home", kind === "non-Mac" ? "linux" : "macos", status);
    expect(f.notice(f.home).hidden).toBe(true);
    expect(f.notice(f.spark).hidden).toBe(true);
    f.button().dispatch("click");
    expect(f.client.restartPassiveLearningCollection).not.toHaveBeenCalled();
  });

  test("keeps shared progress visible across starting events and prevents duplicate actions", async () => {
    const f = await fixture();
    const pending = deferred<{ ok: boolean; status: ReturnType<typeof blockedStatus> }>();
    f.client.restartPassiveLearningCollection.mockReturnValueOnce(pending.promise);
    f.button(f.home).dispatch("click");
    f.button(f.spark).dispatch("click");
    const starting = { ...blockedStatus(), collectionState: "starting", collectionReason: "" };
    f.setStatus(starting);
    await f.feature.refresh();
    for (const root of [f.home, f.spark]) {
      expect(f.notice(root).hidden).toBe(false);
      expect(f.notice(root).attributes.get("aria-busy")).toBe("true");
      expect(f.button(root).disabled).toBe(true);
    }
    expect(f.client.restartPassiveLearningCollection).toHaveBeenCalledOnce();
    pending.resolve({ ok: true, status: starting });
    await vi.waitFor(() => expect(f.feature.snapshot().restartingCollection).toBe(false));
    expect(f.notice().hidden).toBe(true);
  });

  test("shows action failure on both surfaces and allows an explicit retry", async () => {
    const f = await fixture();
    f.client.restartPassiveLearningCollection.mockRejectedValueOnce(new Error("Collection could not restart."));
    f.button().dispatch("click");
    await vi.waitFor(() => expect(f.feature.snapshot().saving).toBe(false));
    expect(f.home.querySelector("[data-learning-status]")!.textContent).toContain("could not restart");
    expect(f.spark.querySelector("[data-learning-feedback]")!.textContent).toContain("could not restart");
    expect(f.notice().hidden).toBe(false);
    expect(f.button().disabled).toBe(false);
    f.button().dispatch("click");
    await vi.waitFor(() => expect(f.client.restartPassiveLearningCollection).toHaveBeenCalledTimes(2));
  });

  test.each(["success", "failure"])("ignores stale restart %s after changing environments", async (outcome) => {
    const f = await fixture();
    const pending = deferred<{ ok: boolean; status: ReturnType<typeof blockedStatus> }>();
    f.client.restartPassiveLearningCollection.mockReturnValueOnce(pending.promise);
    f.button().dispatch("click");
    f.changeEnvironment();
    await vi.waitFor(() => expect(f.feature.snapshot().environmentId).toBe("prod"));
    if (outcome === "success") pending.resolve({ ok: true, status: { ...blockedStatus(), pendingObservations: 999 } });
    else pending.reject(new Error("Old environment failure"));
    await vi.waitFor(() => expect(f.feature.snapshot().hostConnection).toEqual(f.host));
    expect(f.feature.snapshot().status.pendingObservations).toBe(3);
    expect(f.feature.snapshot().statusError).toBe("");
    expect(f.feature.snapshot().saving).toBe(false);
    expect(f.feature.snapshot().restartingCollection).toBe(false);
  });

  test("does not send the displayed environment's action to a newly selected environment", async () => {
    const f = await fixture();
    f.changeEnvironmentWithoutRefresh();
    f.button().dispatch("click");
    expect(f.client.restartPassiveLearningCollection).not.toHaveBeenCalled();
  });
});

test("collection restart transport posts an empty body to the selected environment", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const client = createRuntimeWebClient({ getConfig: () => ({ apiBasePath: "/web-api", backend: "runtime" }),
    getEnvironmentId: () => "dev one", fetchImpl, origin: "http://localhost:5177" });
  await client.restartPassiveLearningCollection();
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("/web-api/runtime/learning/collection/restart?environment=dev%20one",
    expect.objectContaining({ method: "POST", body: "{}" }));
});
