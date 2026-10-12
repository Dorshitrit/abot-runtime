import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createPassiveLearningFeature } from "../../web-ui/app/passive-learning-feature.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function harness(enabled = false, collectionReason = enabled ? "collection_consent_required" : "") {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  vi.stubGlobal("document", { visibilityState: "visible" });
  const home = document.createElement("section"), spark = document.createElement("section");
  document.body.append(home); document.body.append(spark);
  let accepted = false, environment = "dev";
  let status = {
    preferences: { enabled, processingPaused: true, modelProfileId: "learning",
      activityPermissions: { collection: true, learning: false, proactive: false } },
    state: enabled ? "permission_required" : "off", collectionState: enabled ? "permission_required" : "off",
    collectionReason, reason: "",
    pendingObservations: 0, processing: false, activeBatches: 0, recentMemories: [],
  };
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ ok: true, status })),
    getSystemHostConnection: vi.fn(async () => ({
      paired: true, connected: false, hostId: "obsolete-companion",
      identity: { os: "macos", homeDir: "/fixture/old-mac" },
      companion: { updateAvailable: true, installedVersion: 6 },
      collectionSource: { mode: "native", platform: "windows" }, collectionConsent: { accepted },
      readiness: { ready: false, route: "companion", platforms: ["windows"] },
    })),
    acceptSystemHostCollectionConsent: vi.fn(async () => {
      accepted = true; return { ok: true, collectionConsent: { accepted: true } };
    }),
    configurePassiveLearning: vi.fn(async (preferences: Record<string, unknown>, _environment: string) => {
      status = { ...status, preferences: { ...status.preferences, ...preferences } };
      return { ok: true, status };
    }),
    restartPassiveLearningCollection: vi.fn(async () => {
      status = { ...status, state: "starting", collectionState: "starting", collectionReason: "" };
      return { ok: true, status };
    }),
    listPassiveLearningBatches: vi.fn(async () => ({ items: [] })),
    listPassiveLearningCandidates: vi.fn(async () => ({ items: [] })),
    listModels: vi.fn(async () => ({ profiles: [{ id: "learning", label: "Selected model", providerId: "openai" }] })),
  };
  const openComputerAccess = vi.fn();
  const feature = createPassiveLearningFeature({ client, getEnvironmentId: () => environment,
    learningRoot: spark, openLearning: vi.fn(), showActivityMemories: vi.fn(), openComputerAccess });
  feature.mountHome(home); feature.setWorkspace("home");
  return { document, home, spark, client, feature, openComputerAccess,
    acceptElsewhere: () => { accepted = true; },
    changeEnvironment: () => { environment = "prod"; feature.environmentChanged(); },
    async start() {
      await vi.waitFor(() => expect(feature.snapshot().hostConnection).not.toBeNull());
      home.querySelector("[data-learning-open]")!.dispatch("click");
    },
    async approve() {
      await vi.waitFor(() => expect(document.body.querySelector("[data-collection-consent-acknowledged]")).not.toBeNull());
      const checkbox = document.body.querySelector("[data-collection-consent-acknowledged]")!;
      Object.assign(checkbox, { checked: true }); checkbox.dispatch("change");
      document.body.querySelector("[data-collection-consent-continue]")!.dispatch("click");
    } };
}
afterEach(() => vi.unstubAllGlobals());

describe("collection acknowledgment through Home and Spark", () => {
  test("native Home acknowledges once before Start and ignores an old Mac Companion pairing", async () => {
    const h = harness(); await h.start();
    expect(h.client.configurePassiveLearning).not.toHaveBeenCalled();
    expect(h.client.acceptSystemHostCollectionConsent).not.toHaveBeenCalled();
    await h.approve();
    await vi.waitFor(() => expect(h.client.configurePassiveLearning).toHaveBeenCalledOnce());
    expect(h.client.acceptSystemHostCollectionConsent).toHaveBeenCalledOnce();
    expect(h.client.configurePassiveLearning).toHaveBeenCalledWith({ enabled: true }, "dev");
    expect(h.client.restartPassiveLearningCollection).not.toHaveBeenCalled();
    expect(h.feature.snapshot().hostConnection.collectionConsent.accepted).toBe(true);
    expect(h.openComputerAccess).not.toHaveBeenCalled();
    expect(h.spark.querySelector("[data-learning-companion-version]")?.hidden).toBe(true);
    expect(h.spark.querySelector("[data-learning-computer-access]")?.hidden).toBe(true);
    expect(h.spark.querySelector("[data-learning-update]")?.hidden).toBe(true);
    expect(h.document.body.querySelector("[data-mac-permission-path]")).toBeNull();
    expect(h.spark.querySelector("[data-learning-device]")?.textContent).toBe("This Windows computer");
    h.feature.setWorkspace("");
  });
  test("native collection hides stale Mac permission notices from an old pairing", async () => {
    const h = harness(true, "macos_accessibility_permission_timeout");
    await vi.waitFor(() => expect(h.feature.snapshot().hostConnection).not.toBeNull());
    expect(h.home.querySelector("[data-learning-mac-restart]")?.hidden).toBe(true);
    expect(h.spark.querySelector("[data-learning-mac-restart]")?.hidden).toBe(true);
    h.feature.setWorkspace("");
  });
  test("already enabled collection blocked on consent has an explicit review and restart action", async () => {
    const h = harness(true);
    await vi.waitFor(() => expect(h.home.querySelector("[data-learning-open]")?.textContent).toBe("Review collection access"));
    await h.start(); await h.approve();
    await vi.waitFor(() => expect(h.client.restartPassiveLearningCollection).toHaveBeenCalledOnce());
    expect(h.client.configurePassiveLearning).toHaveBeenCalledWith({ enabled: true }, "dev");
    expect(h.openComputerAccess).not.toHaveBeenCalled();
    h.feature.setWorkspace("");
  });
  test("another tab's saved acknowledgment is refreshed before showing any dialog", async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.feature.snapshot().hostConnection).not.toBeNull());
    h.acceptElsewhere(); await h.start();
    await vi.waitFor(() => expect(h.client.configurePassiveLearning).toHaveBeenCalledOnce());
    expect(h.document.body.querySelector("[data-collection-consent-acknowledged]")).toBeNull();
    expect(h.client.acceptSystemHostCollectionConsent).not.toHaveBeenCalled();
    h.feature.setWorkspace("");
  });
  test("environment changes dismiss acknowledgment without applying the old collection request", async () => {
    const h = harness(); await h.start();
    await vi.waitFor(() => expect(h.document.body.querySelector("dialog")?.open).toBe(true));
    h.changeEnvironment();
    expect(h.document.body.querySelector("dialog")?.open).toBe(false);
    expect(h.client.acceptSystemHostCollectionConsent).not.toHaveBeenCalled();
    expect(h.client.configurePassiveLearning).not.toHaveBeenCalled();
    h.feature.setWorkspace("");
  });
});
