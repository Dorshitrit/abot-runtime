import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only feature has no declaration surface.
import { createPassiveLearningFeature } from "../../web-ui/app/passive-learning-feature.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const doc = { visibilityState: "visible", addEventListener: vi.fn() } as unknown as ConstructorParameters<typeof FakeElement>[1];
  doc.createElement = (tag) => new FakeElement(tag, doc);
  doc.documentElement = doc.createElement("html");
  doc.body = doc.createElement("body");
  vi.stubGlobal("document", doc);
  const homeRoot = doc.createElement("section");
  const learningRoot = doc.createElement("section");
  doc.body.append(homeRoot);
  doc.body.append(learningRoot);
  const proposals = ["delivered", "dismissed", "pending"].map((status) => ({
    id: status, sessionId: "spark-companion", status,
    title: "Historical proposal title", message: "Historical proposal body",
  }));
  const current = {
    preferences: { enabled: false, processingPaused: true, proactiveEnabled: true,
      modelProfileId: "local", excludedApplications: [], analysisIntervalMinutes: 15, maxConcurrentBatches: 1 },
    state: "off", pendingObservations: 0, processing: false, activeBatches: 0, recentMemories: [],
    proactive: { state: "waiting", proposals },
  };
  const client = {
    loadPassiveLearning: vi.fn(async () => ({ ok: true, status: current })),
    listPassiveLearningBatches: vi.fn(async () => ({ items: [] })),
    listModels: vi.fn(async () => ({ profiles: [] })),
    getSystemHostConnection: vi.fn(async () => ({ readiness: { ready: true } })),
    configurePassiveLearning: vi.fn(),
  };
  const openLearning = vi.fn();
  const feature = createPassiveLearningFeature({ client, getEnvironmentId: () => "dev", learningRoot,
    openLearning, openComputerAccess: vi.fn(), showActivityMemories: vi.fn() });
  feature.mountHome(homeRoot);
  return { doc, homeRoot, learningRoot, current, client, feature, openLearning };
}

function expectNoProposalSurface(f: ReturnType<typeof fixture>) {
  for (const view of [f.homeRoot, f.learningRoot]) {
    expect(view.querySelector("[data-learning-proposals]")).toBeNull();
    expect(view.querySelector("[data-learning-proposal-open]")).toBeNull();
    expect(view.textContent).not.toContain("Historical proposal body");
  }
  expect(f.doc.body.querySelector(".co-worker-proposal-toast")).toBeNull();
}

describe("SPARK workspace status without duplicate proposal surfaces", () => {
  test.each(["home", "learning"])("keeps actual proactive status and stored history on %s", async (workspace) => {
    const f = fixture();
    const history = structuredClone(f.current.proactive.proposals);
    f.feature.setWorkspace(workspace);
    await vi.waitFor(() => expect(f.feature.snapshot().status).not.toBeNull());
    expectNoProposalSurface(f);
    for (const view of [f.homeRoot, f.learningRoot]) {
      expect(view.querySelector("[data-agent-proactive]")?.textContent).toContain("Enabled");
      expect(view.querySelector("[data-agent-collection]")?.textContent).toContain("stopped");
      expect(view.querySelector("[data-coworker-agent]")?.dataset.agentMode).toBe("waiting");
    }
    f.homeRoot.querySelector("[data-learning-open]")!.dispatch("click");
    expect(f.openLearning).toHaveBeenCalledOnce();
    expect(f.client.configurePassiveLearning).not.toHaveBeenCalled();
    expect(f.learningRoot.querySelector("[data-learning-proactive-toggle]")?.disabled).toBe(false);
    expect(f.learningRoot.querySelector('[data-learning-tab="chat"]')).not.toBeNull();
    expect(f.learningRoot.querySelector('[data-learning-tab="settings"]')).not.toBeNull();
    expect(f.current.proactive.proposals).toEqual(history);
  });

  test.each(["spark-companion", "historical-proposal-session"])("refreshes status without legacy cards or toasts for delivery to %s", async (sessionId) => {
    const f = fixture();
    f.feature.setWorkspace("home");
    await vi.waitFor(() => expect(f.feature.snapshot().status).not.toBeNull());
    const history = structuredClone(f.current.proactive.proposals);
    f.current.proactive.state = "failed";
    f.feature.handleRealtime({ type: "learning.changed", environmentId: "dev",
      event: { type: "proposal_delivered", proposalId: "delivered", sessionId } });
    await vi.waitFor(() => expect(f.client.loadPassiveLearning).toHaveBeenCalledTimes(2));
    expectNoProposalSurface(f);
    expect(f.homeRoot.querySelector("[data-coworker-agent]")?.dataset.agentMode).toBe("attention");
    expect(f.feature.snapshot().status.proactive.proposals).toEqual(history);
    expect(f.current.proactive.proposals).toEqual(history);
    expect(f.doc.body.children).toHaveLength(2);
  });
});
