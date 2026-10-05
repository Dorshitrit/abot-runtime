import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const draft = (automationId: string) => ({ draft: { automationId, revision: 1,
  definition: { automationId, title: automationId, body: {
    kind: "sequence", id: "root", children: [],
  } } } });

function fixture() {
  let environment = "dev";
  let dirty = false;
  let runStatus = "running";
  let pendingDraft: Promise<ReturnType<typeof draft>> | null = null;
  let pendingFullEvidence: Promise<unknown> | null = null;
  const render = vi.fn();
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async () => ({ automations: [
      { id: "one", title: "One" }, { id: "two", title: "Two" },
    ] })),
    getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
    getAutomationDraft: vi.fn(async (automationId: string) =>
      automationId === "one" && pendingDraft ? pendingDraft : draft(automationId)),
    listAutomationRuns: vi.fn(async () => ({ runs: [
      { id: "run-1", status: runStatus }, { id: "run-2", status: runStatus },
    ] })),
    getAutomationRun: vi.fn(async (runId: string) => ({ run: {
      id: runId, automationId: "one", status: runStatus,
    } })),
    getAutomationStepEvidence: vi.fn(async (runId: string, nodeId: string,
      _environmentId: string, full: boolean) =>
      full && pendingFullEvidence ? pendingFullEvidence : { evidence: {
        runId, nodeId, availability: "available", output: { full }, effects: [],
      } }),
  };
  const controller = createAutomationsController({ client,
    getEnvironmentId: () => environment, render, isVisible: () => true,
    isEditingDirty: () => dirty });
  return { client, controller, render,
    setEnvironment: (value: string) => { environment = value; },
    setDirty: (value: boolean) => { dirty = value; },
    setRunStatus: (value: string) => { runStatus = value; },
    blockDraft: (promise: Promise<ReturnType<typeof draft>> | null) => { pendingDraft = promise; },
    blockFullEvidence: (promise: Promise<unknown> | null) => { pendingFullEvidence = promise; },
  };
}

async function flushReads() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function openRunning(f: ReturnType<typeof fixture>) {
  await f.controller.openRoute("one", "run-1");
  f.controller.setWorkspaceActive(true);
  f.render.mockClear();
}

async function event(f: ReturnType<typeof fixture>, environment = "dev") {
  f.controller.handleRealtime({ type: "event", name: "scheduler.changed", environment });
  await vi.advanceTimersByTimeAsync(80);
  await flushReads();
}

afterEach(() => vi.useRealTimers());

describe("ABot Studio background refresh", () => {
  test("unchanged events do not render; a changed run publishes one complete frame", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await openRunning(f);
    await event(f);
    expect(f.render).not.toHaveBeenCalled();
    f.setRunStatus("succeeded");
    await event(f);
    expect(f.render).toHaveBeenCalledOnce();
    expect(f.render.mock.calls[0]?.[0]).toMatchObject({
      loading: false, selectedRunId: "run-1", run: { status: "succeeded" },
    });
  });

  test("an in-flight read cannot replace edits made after it began", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await openRunning(f);
    const held = deferred<ReturnType<typeof draft>>();
    f.blockDraft(held.promise);
    f.setRunStatus("succeeded");
    await event(f);
    expect(f.client.getAutomationDraft).toHaveBeenCalledTimes(2);
    f.setDirty(true);
    held.resolve(draft("one"));
    await flushReads();
    expect(f.render).not.toHaveBeenCalled();
    expect(f.controller.snapshot().run.status).toBe("running");
  });

  test("route changes discard a stale read and permit a fresh-scope event", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await openRunning(f);
    const held = deferred<ReturnType<typeof draft>>();
    f.blockDraft(held.promise);
    await event(f);
    await f.controller.openRoute("two");
    await event(f);
    expect(f.client.getAutomationDraft.mock.calls.filter(([id]) => id === "two")).toHaveLength(2);
    const rendersAfterRoute = f.render.mock.calls.length;
    held.resolve(draft("one"));
    await flushReads();
    expect(f.render).toHaveBeenCalledTimes(rendersAfterRoute);
    expect(f.controller.snapshot().selectedAutomationId).toBe("two");
  });

  test("an environment switch rejects old reads and starts refresh in the new scope", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await openRunning(f);
    const held = deferred<ReturnType<typeof draft>>();
    f.blockDraft(held.promise);
    await event(f);
    f.setEnvironment("prod");
    f.controller.environmentChanged();
    await flushReads();
    const listCallsAfterSwitch = f.client.listAutomations.mock.calls.length;
    await event(f, "prod");
    expect(f.client.listAutomations).toHaveBeenCalledTimes(listCallsAfterSwitch + 1);
    const rendersAfterSwitch = f.render.mock.calls.length;
    held.resolve(draft("one"));
    await flushReads();
    expect(f.render).toHaveBeenCalledTimes(rendersAfterSwitch);
    expect(f.controller.snapshot().selectedAutomationId).toBe("");
    expect(f.controller.snapshot().automations).toHaveLength(2);
  });

  test("node changes reject stale evidence without replacing the selected step", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await openRunning(f);
    f.controller.selectNode("node-a");
    await flushReads();
    const held = deferred<ReturnType<typeof draft>>();
    f.blockDraft(held.promise);
    await event(f);
    f.controller.selectNode("node-b");
    await flushReads();
    const rendersAfterNode = f.render.mock.calls.length;
    held.resolve(draft("one"));
    await flushReads();
    expect(f.render).toHaveBeenCalledTimes(rendersAfterNode);
    expect(f.controller.snapshot().stepEvidence).toMatchObject({ nodeId: "node-b" });
  });

  test("full evidence stays visible during expansion and remains full on refresh", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await openRunning(f);
    f.controller.selectNode("node-a");
    await flushReads();
    expect(f.controller.snapshot().stepEvidence).toMatchObject({ output: { full: false } });
    const held = deferred<unknown>();
    f.blockFullEvidence(held.promise);
    const expanding = f.controller.showFullStepOutput();
    expect(f.controller.snapshot()).toMatchObject({
      stepEvidenceLoading: true, stepEvidence: { output: { full: false } },
    });
    held.resolve({ evidence: { runId: "run-1", nodeId: "node-a",
      availability: "available", output: { full: true }, effects: [] } });
    await expanding;
    f.blockFullEvidence(null);
    expect(f.controller.snapshot().stepEvidence.output.full).toBe(true);
    await event(f);
    expect(f.client.getAutomationStepEvidence).toHaveBeenLastCalledWith(
      "run-1", "node-a", "dev", true);
    expect(f.controller.snapshot().stepEvidence.output.full).toBe(true);
    await f.controller.openRun("run-2");
    f.controller.selectNode("node-a");
    await flushReads();
    expect(f.client.getAutomationStepEvidence).toHaveBeenLastCalledWith(
      "run-2", "node-a", "dev", false);
  });
});
