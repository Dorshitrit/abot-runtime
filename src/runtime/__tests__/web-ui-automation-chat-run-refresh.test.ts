import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationChatRunProjection } from "../../web-ui/app/components/automations/chat-run-projection.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class Panel {
  markup = "";
  firstChild: object | null = null;
  writes = 0;
  scrollTop = 0;
  scrollLeft = 0;
  hidden = false;
  inert = false;
  attributes = new Map<string, string>();
  ownerDocument = { activeElement: null };
  listeners = new Map<string, (event: unknown) => void>();

  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    this.firstChild = value ? {} : null;
    this.writes += 1;
  }
  contains(node: unknown) { return node === this; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, callback: (event: unknown) => void) {
    this.listeners.set(name, callback);
  }
  click(dataset: Record<string, string>) {
    this.listeners.get("click")?.({ target: { closest: () => ({ dataset }) } });
  }
}

const definition = {
  schemaVersion: 1, automationId: "automation-1", revision: 1,
  title: "Daily report", objective: "", trigger: { kind: "manual" }, inputs: {},
  body: { kind: "sequence", id: "root", children: [{
    kind: "agent", id: "step-1", title: "Summarize", onFailure: "stop",
    modelProfileId: "model", agentMode: "fast", roleInstructions: "", prompt: "",
    inputs: {}, tools: [], result: { kind: "text" },
  }, { kind: "agent", id: "step-2", title: "Review", onFailure: "stop",
    modelProfileId: "model", agentMode: "fast", roleInstructions: "", prompt: "",
    inputs: {}, tools: [], result: { kind: "text" },
  }] },
};

function run(id: string, status = "running") {
  return { id, automationId: "automation-1", status, definition,
    nodes: [{ nodeId: "step-1", status: "succeeded" },
      { nodeId: "step-2", status: "running" }] };
}

function evidence(runId: string, nodeId: string, value: string, full = false) {
  return { runId, nodeId, title: nodeId, availability: "available",
    stepStatus: "succeeded", inputs: [], effects: [],
    output: { text: { value, totalCharacters: value.length, truncated: !full },
      data: null, full } };
}

function fixture() {
  const panel = new Panel();
  const classes = new Set<string>();
  const app = { classList: {
    toggle(name: string, enabled: boolean) {
      if (enabled) classes.add(name); else classes.delete(name);
    },
    contains(name: string) { return classes.has(name); },
  } };
  const dom = { app, automationChatRunPanel: panel, chatPanel: {},
    sessionsPanel: {}, sessionsToggleButton: {} };
  let environmentId = "dev";
  const client = {
    getAutomationRun: vi.fn(async (id: string) => ({ run: run(id) })),
    getAutomationStepEvidence: vi.fn(async (id: string, nodeId: string) =>
      ({ evidence: evidence(id, nodeId, "PREVIEW") })),
    stopAutomationRun: vi.fn(),
  };
  const projection = createAutomationChatRunProjection({
    dom, client, getEnvironmentId: () => environmentId,
    onNavigationChange: vi.fn(), returnToStudio: vi.fn(), isVisible: () => true,
  });
  projection.workspaceChanged("chat");
  return { panel, dom, client, projection,
    setEnvironment: (value: string) => { environmentId = value; } };
}

async function refresh(projection: ReturnType<typeof fixture>["projection"], runId: string) {
  projection.handleRealtime({ type: "event", name: "automation.run.finished",
    environment: "dev", runId });
  await vi.advanceTimersByTimeAsync(80);
}

afterEach(() => { vi.useRealTimers(); });

describe("ABot Studio locked chat run refresh", () => {
  it("keeps the loaded run and default step when initial evidence fails, then permits another step", async () => {
    const { panel, client, projection } = fixture();
    client.getAutomationStepEvidence.mockRejectedValueOnce(new Error("Initial evidence unavailable"));
    expect(await projection.open("run-1")).toBe(false);
    expect(panel.innerHTML).toContain("Daily report");
    expect(panel.innerHTML).toMatch(/data-automation-node="step-1" data-state="succeeded" aria-pressed="true"/);
    expect(panel.innerHTML).toContain('aria-label="Step evidence"><h4>Step result</h4><p role="alert">Initial evidence unavailable</p>');
    expect(panel.innerHTML).toContain('data-automation-node="step-2"');
    panel.click({ automationNode: "step-2" });
    await vi.waitFor(() => expect(panel.innerHTML).toContain("PREVIEW"));
    expect(panel.innerHTML).toMatch(/data-automation-node="step-2" data-state="running" aria-pressed="true"/);
    expect(panel.innerHTML).not.toContain("Initial evidence unavailable");
    expect(client.getAutomationStepEvidence).toHaveBeenLastCalledWith("run-1", "step-2", "dev", false);
  });

  it.each(["step", "run"])("ignores stale initial evidence failure after switching %s", async (destination) => {
    const { panel, client, projection } = fixture();
    const pendingEvidence = deferred<{ evidence: ReturnType<typeof evidence> }>();
    client.getAutomationStepEvidence.mockImplementationOnce(() => pendingEvidence.promise);
    const opening = projection.open("run-1");
    await vi.waitFor(() => expect(client.getAutomationStepEvidence).toHaveBeenCalledOnce());
    expect(panel.innerHTML).toMatch(/data-automation-node="step-1" data-state="succeeded" aria-pressed="true"/);
    if (destination === "step") panel.click({ automationNode: "step-2" });
    if (destination === "run") await projection.open("run-2");
    await vi.waitFor(() => expect(panel.innerHTML).toContain("PREVIEW"));
    pendingEvidence.reject(new Error("Stale initial evidence failure"));
    await opening;
    expect(panel.innerHTML).not.toContain("Stale initial evidence failure");
    expect(projection.runId()).toBe(destination === "run" ? "run-2" : "run-1");
    const selectedStep = destination === "step" ? "step-2" : "step-1";
    expect(panel.innerHTML).toContain(`data-automation-node="${selectedStep}" data-state="${destination === "step" ? "running" : "succeeded"}" aria-pressed="true"`);
  });

  it("selects the first step on opening, retains manual selection, and resets it for a new run", async () => {
    vi.useFakeTimers();
    const { panel, client, projection } = fixture();
    await projection.open("run-1");
    expect(panel.innerHTML).toMatch(/data-automation-node="step-1" data-state="succeeded" aria-pressed="true"/);
    expect(panel.innerHTML).toContain("PREVIEW");
    expect(panel.innerHTML).not.toContain("Choose a step to explore its saved result.");
    expect(client.getAutomationStepEvidence).toHaveBeenCalledExactlyOnceWith("run-1", "step-1", "dev", false);
    panel.click({ automationNode: "step-2" });
    await vi.waitFor(() => expect(client.getAutomationStepEvidence)
      .toHaveBeenLastCalledWith("run-1", "step-2", "dev", false));
    await refresh(projection, "run-1");
    expect(panel.innerHTML).toMatch(/data-automation-node="step-2" data-state="running" aria-pressed="true"/);
    await projection.open("run-2");
    expect(panel.innerHTML).toMatch(/data-automation-node="step-1" data-state="succeeded" aria-pressed="true"/);
    expect(client.getAutomationStepEvidence).toHaveBeenLastCalledWith("run-2", "step-1", "dev", false);
  });

  it("keeps the selected evidence and scroll until one coherent background render", async () => {
    vi.useFakeTimers();
    const { panel, dom, client, projection } = fixture();
    await projection.open("run-1");
    expect(client.getAutomationRun).toHaveBeenCalledWith("run-1", "dev");
    expect(dom.chatPanel).toEqual({ hidden: true, inert: true });
    expect(dom.sessionsPanel).toEqual({ hidden: true, inert: true });
    expect(panel.hidden).toBe(false);
    expect(panel.innerHTML).toContain('data-action="stop"');
    expect(panel.innerHTML).not.toContain('data-action="rerun"');
    panel.click({ automationNode: "step-1" });
    await vi.waitFor(() => expect(panel.innerHTML).toContain("PREVIEW"));
    panel.scrollTop = 231;
    const nextRun = deferred<{ run: ReturnType<typeof run> }>();
    const nextEvidence = deferred<{ evidence: ReturnType<typeof evidence> }>();
    client.getAutomationRun.mockImplementationOnce(() => nextRun.promise);
    client.getAutomationStepEvidence.mockImplementationOnce(() => nextEvidence.promise);
    const before = panel.writes;
    projection.handleRealtime({ type: "event", name: "automation.run.finished",
      environment: "dev", runId: "another-run" });
    await vi.advanceTimersByTimeAsync(80);
    expect(client.getAutomationRun).toHaveBeenCalledTimes(1);
    const pending = refresh(projection, "run-1");
    await vi.advanceTimersByTimeAsync(80);
    expect(panel.writes).toBe(before);
    nextRun.resolve({ run: run("run-1", "succeeded") });
    await Promise.resolve();
    expect(panel.writes).toBe(before);
    nextEvidence.resolve({ evidence: evidence("run-1", "step-1", "UPDATED") });
    await pending;
    expect(panel.writes).toBe(before + 1);
    expect(panel.scrollTop).toBe(231);
    expect(panel.innerHTML).toContain("UPDATED");
  });

  it("keeps preview visible during full-output loading and requests full detail on refresh", async () => {
    vi.useFakeTimers();
    const { panel, client, projection } = fixture();
    await projection.open("run-1");
    panel.click({ automationNode: "step-1" });
    await vi.waitFor(() => expect(panel.innerHTML).toContain("PREVIEW"));
    const fullRead = deferred<{ evidence: ReturnType<typeof evidence> }>();
    client.getAutomationStepEvidence.mockImplementationOnce(() => fullRead.promise);
    panel.click({ action: "show-full-step-output" });
    expect(panel.innerHTML).toContain("PREVIEW");
    fullRead.resolve({ evidence: evidence("run-1", "step-1", "FULL TEXT", true) });
    await vi.waitFor(() => expect(panel.innerHTML).toContain("FULL TEXT"));
    await refresh(projection, "run-1");
    expect(client.getAutomationStepEvidence).toHaveBeenLastCalledWith(
      "run-1", "step-1", "dev", true,
    );
    panel.click({ automationNode: "step-2" });
    await vi.waitFor(() => expect(client.getAutomationStepEvidence)
      .toHaveBeenLastCalledWith("run-1", "step-2", "dev", false));
    await refresh(projection, "run-1");
    expect(client.getAutomationStepEvidence).toHaveBeenLastCalledWith(
      "run-1", "step-2", "dev", false,
    );
  });

  it("defers realtime refresh until an explicit full-output read settles", async () => {
    vi.useFakeTimers();
    const { panel, client, projection } = fixture();
    await projection.open("run-1");
    panel.click({ automationNode: "step-1" });
    await vi.waitFor(() => expect(panel.innerHTML).toContain("PREVIEW"));
    const fullRead = deferred<{ evidence: ReturnType<typeof evidence> }>();
    client.getAutomationStepEvidence.mockImplementationOnce(() => fullRead.promise);
    panel.click({ action: "show-full-step-output" });
    projection.handleRealtime({ type: "event", name: "automation.run.finished",
      environment: "dev", runId: "run-1" });
    await vi.advanceTimersByTimeAsync(80);
    expect(client.getAutomationRun).toHaveBeenCalledTimes(1);
    fullRead.resolve({ evidence: evidence("run-1", "step-1", "FULL TEXT", true) });
    await vi.waitFor(() => expect(panel.innerHTML).toContain("FULL TEXT"));
    await vi.advanceTimersByTimeAsync(80);
    expect(client.getAutomationRun).toHaveBeenCalledTimes(2);
    expect(client.getAutomationStepEvidence).toHaveBeenLastCalledWith(
      "run-1", "step-1", "dev", true,
    );
  });

  it("retains prior output on refresh failure and ignores stale reads after navigation", async () => {
    vi.useFakeTimers();
    const { panel, client, projection } = fixture();
    await projection.open("run-1");
    panel.click({ automationNode: "step-1" });
    await vi.waitFor(() => expect(panel.innerHTML).toContain("PREVIEW"));
    client.getAutomationStepEvidence.mockRejectedValueOnce(new Error("Evidence temporarily unavailable"));
    await refresh(projection, "run-1");
    expect(panel.innerHTML).toContain("PREVIEW");
    expect(panel.innerHTML).toContain("Evidence temporarily unavailable");
    const stale = deferred<{ run: ReturnType<typeof run> }>();
    client.getAutomationRun.mockImplementationOnce(() => stale.promise);
    const pending = refresh(projection, "run-1");
    await vi.advanceTimersByTimeAsync(80);
    await projection.open("run-2");
    stale.resolve({ run: run("run-1", "succeeded") });
    await pending;
    expect(projection.runId()).toBe("run-2");
    expect(panel.innerHTML).toContain('id="automation-step-result-chat-run-2"');
    expect(panel.innerHTML).not.toContain('id="automation-step-result-chat-run-1"');
    expect(panel.innerHTML).not.toContain("Evidence temporarily unavailable");
  });
});
