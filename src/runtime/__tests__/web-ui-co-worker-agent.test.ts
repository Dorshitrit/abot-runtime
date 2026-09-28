import { describe, expect, test, vi } from "vitest";
import { DEFAULT_LEARNING_PREFERENCES } from "../passive-learning/store.js";
// @ts-expect-error Browser component has no declarations.
import { coWorkerAgentState, coWorkerActivityStates } from "../../web-ui/app/components/passive-learning/agent-state.js";
// @ts-expect-error Browser component has no declarations.
import { agentMarkup, renderAgent } from "../../web-ui/app/components/passive-learning/agent-view.js";
// @ts-expect-error Browser component has no declarations.
import { createAgentMotion } from "../../web-ui/app/components/passive-learning/agent-motion.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function status() {
  return { preferences: { enabled: false, processingPaused: true, proactiveEnabled: true, modelProfileId: "model" },
    state: "off", pendingObservations: 0, processing: false,
    proactive: { state: "waiting", proposals: [] }, recentMemories: [] };
}
function rootFixture(compact = false) {
  const listeners = new Map<string, () => void>();
  const doc = { visibilityState: "visible", addEventListener: (key: string, callback: () => void) => listeners.set(key, callback),
    removeEventListener: (key: string) => listeners.delete(key) } as any;
  doc.createElement = (tag: string) => new FakeElement(tag, doc);
  const root: FakeElement = doc.createElement("section");
  root.innerHTML = agentMarkup({ compact });
  return { root, doc, listeners };
}

function expectPhaseState(root: FakeElement, phase: string, state: string) {
  expect(root.querySelector(`[data-orbit-phase="${phase}"]`)?.attributes.get("data-phase-state")).toBe(state);
  expect(root.querySelector(`[data-agent-phase="${phase}"]`)?.attributes.get("data-phase-state")).toBe(state);
  expect(root.querySelector(`[data-agent-${phase}]`)?.attributes.get("data-phase-state")).toBe(state);
}

describe("Co-worker state and motion", () => {
  test("fresh learning requests a model before offering processing", () => {
    const fresh = { ...status(), preferences: DEFAULT_LEARNING_PREFERENCES };
    expect(coWorkerActivityStates(fresh).processing[0]).toBe("Choose a model");
    expect(coWorkerAgentState({ status: fresh }).mode).toBe("quiet");
  });

  test("shows count progress independently from the interval and blocked observations", () => {
    const current = { ...status(), pendingObservations: 23, blockedObservations: 70,
      preferences: { ...status().preferences, processingPaused: false, modelProfileId: "local",
        analysisTrigger: "observations", analysisObservationCount: 100 } };
    expect(coWorkerActivityStates(current).processing).toEqual(["23 observations waiting", "23 / 100 eligible observations"]);
    expect(coWorkerActivityStates({ ...current, processing: true }).processing[0]).toBe("Processing now");
    expect(coWorkerActivityStates({ ...current, reviewPassRemaining: 20 }).processing[1]).toBe("20 observations left in this review");
  });

  test("proactive-only waiting is not presented as a stopped agent", () => {
    const snapshot = { status: status() };
    expect(coWorkerAgentState(snapshot).mode).toBe("waiting");
    const axes = coWorkerActivityStates(snapshot.status);
    expect(axes.collection[0]).toBe("Collection stopped");
    expect(axes.processing[0]).toBe("Paused");
    expect(axes.proactive[0]).toContain("Enabled");
  });
  test("shows model work independently of recording and stops motion state when it settles", () => {
    const snapshot = { status: { ...status(), proactive: { state: "reviewing", proposals: [] } } };
    expect(coWorkerAgentState(snapshot).mode).toBe("reviewing");
    snapshot.status.proactive.state = "waiting";
    expect(coWorkerAgentState(snapshot).mode).toBe("waiting");
    snapshot.status.preferences.proactiveEnabled = false;
    expect(coWorkerAgentState(snapshot).mode).toBe("quiet");
  });
  test("unsettled or dismissed proposals do not masquerade as a ready conversation", () => {
    const snapshot = { status: { ...status(), proactive: { state: "waiting", proposals: [{ status: "pending" }] } } };
    expect(coWorkerAgentState(snapshot).mode).toBe("waiting");
    snapshot.status.proactive.proposals[0]!.status = "delivered";
    expect(coWorkerAgentState(snapshot).mode).toBe("suggestion");
    snapshot.status.proactive.proposals[0]!.status = "dismissed";
    expect(coWorkerAgentState(snapshot).mode).toBe("waiting");
  });
  test("repeated renders retain the agent DOM instead of restarting animations", () => {
    const { root } = rootFixture();
    const snapshot = { status: status() };
    renderAgent(root, snapshot);
    const core = root.querySelector(".co-worker-core");
    renderAgent(root, { ...snapshot, saving: true });
    expect(root.querySelector(".co-worker-core")).toBe(core);
  });
  test.each([false, true])("each orbit marker matches its named phase in compact=%s", (compact) => {
    const { root } = rootFixture(compact);
    renderAgent(root, { status: status() });
    expect(root.querySelectorAll("[data-orbit-phase]")).toHaveLength(3);
    expect(root.querySelector('[data-agent-phase="collection"]')?.querySelector("span")?.textContent).toBe("Collection");
    expect(root.querySelector('[data-agent-phase="processing"]')?.querySelector("span")?.textContent).toBe("Learning");
    expect(root.querySelector('[data-agent-phase="proactive"]')?.querySelector("span")?.textContent).toBe("Proactive");
    expectPhaseState(root, "collection", "off");
    expectPhaseState(root, "processing", "off");
    expectPhaseState(root, "proactive", "ready");
  });
  test("simultaneous activity updates each marker independently and settles without replacing it", () => {
    const { root } = rootFixture();
    const current = { ...status(), collectionState: "collecting", processing: true,
      preferences: { ...status().preferences, enabled: true, processingPaused: false },
      proactive: { state: "reviewing", proposals: [] } };
    const markers = root.querySelectorAll("[data-orbit-phase]");
    renderAgent(root, { status: current });
    for (const phase of ["collection", "processing", "proactive"]) expectPhaseState(root, phase, "active");
    current.collectionState = "disconnected";
    current.processing = false;
    current.pendingObservations = 4;
    current.proactive.state = "waiting";
    renderAgent(root, { status: current });
    expectPhaseState(root, "collection", "attention");
    expectPhaseState(root, "processing", "waiting");
    expectPhaseState(root, "proactive", "ready");
    current.collectionState = "starting";
    current.proactive.state = "failed";
    renderAgent(root, { status: current });
    expectPhaseState(root, "collection", "waiting");
    expectPhaseState(root, "proactive", "attention");
    for (const [index, marker] of root.querySelectorAll("[data-orbit-phase]").entries()) expect(marker).toBe(markers[index]);
  });
  test("an already running observation review remains active after processing is paused", () => {
    const { root } = rootFixture();
    const current = { ...status(), activeBatches: 1 };
    renderAgent(root, { status: current });
    expect(root.querySelector("[data-agent-processing]")?.textContent).toBe("Processing now");
    expectPhaseState(root, "processing", "active");
    current.activeBatches = 0;
    renderAgent(root, { status: current });
    expectPhaseState(root, "processing", "off");
  });
  test("connection errors stop stale active markers and reconnect restores current activity", () => {
    const { root } = rootFixture();
    const current = { ...status(), proactive: { state: "reviewing", proposals: [] } };
    renderAgent(root, { status: current });
    expectPhaseState(root, "proactive", "active");
    renderAgent(root, { status: current, statusError: "Disconnected" });
    for (const phase of ["collection", "processing", "proactive"]) expectPhaseState(root, phase, "attention");
    expect(root.querySelector("[data-agent-description]")?.textContent).toContain("last known");
    renderAgent(root, { status: current });
    expectPhaseState(root, "collection", "off");
    expectPhaseState(root, "processing", "off");
    expectPhaseState(root, "proactive", "active");
  });
  test("visibility and navigation stop decoration without a timer or refresh", () => {
    const { root, doc, listeners } = rootFixture();
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const motion = createAgentMotion(root);
      const agent = root.querySelector("[data-coworker-agent]");
      motion.update({ status: status(), learningActive: true, homeActive: false });
      expect(agent?.attributes.get("data-motion")).toBe("on");
      doc.visibilityState = "hidden"; listeners.get("visibilitychange")!();
      expect(agent?.attributes.get("data-motion")).toBe("off");
      doc.visibilityState = "visible";
      motion.update({ status: status(), learningActive: false, homeActive: false });
      expect(agent?.attributes.get("data-motion")).toBe("off");
      expect(timer).not.toHaveBeenCalled();
      motion.dispose(); expect(listeners.size).toBe(0);
    } finally { timer.mockRestore(); }
  });
});
