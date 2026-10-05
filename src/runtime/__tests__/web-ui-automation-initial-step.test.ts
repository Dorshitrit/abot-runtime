import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationRun } from "../../web-ui/app/components/automations/run.js";

const definition = {
  title: "Saved report", trigger: { kind: "manual" },
  body: { kind: "sequence", id: "root", children: [{
    kind: "parallel", id: "group", branches: [{
      kind: "sequence", id: "branch", children: [
        { kind: "tool", id: "first", title: "Read source", onFailure: "stop" },
        { kind: "agent", id: "second", title: "Write report", onFailure: "stop" },
      ],
    }],
  }] },
};

function evidence(runId: string, nodeId: string) {
  return { runId, nodeId, title: nodeId, availability: "available", inputs: [], effects: [],
    output: { text: { value: `${runId}/${nodeId} saved output`, truncated: false,
      totalCharacters: 24 }, full: false } };
}

function fixture(frozenDefinition: unknown = definition) {
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async () => ({ automations: [{ id: "automation" }] })),
    getAutomationCatalog: vi.fn(async () => ({})),
    getAutomationDraft: vi.fn(async () => ({ draft: { revision: 1, definition } })),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    getAutomationRun: vi.fn(async (id: string) => ({ run: {
      id, automationId: "automation", status: "succeeded", definition: frozenDefinition,
      nodes: [{ nodeId: "first", status: "succeeded" }, { nodeId: "second", status: "succeeded" }],
    } })),
    getAutomationStepEvidence: vi.fn(async (runId: string, nodeId: string) =>
      ({ evidence: evidence(runId, nodeId) })),
  };
  const controller = createAutomationsController({ client, getEnvironmentId: () => "dev",
    render: vi.fn(), isVisible: () => true });
  return { client, controller };
}

describe("saved automation run initial step selection", () => {
  test("a report route selects the first displayable nested step and loads its exact evidence", async () => {
    const { client, controller } = fixture();
    await controller.openRoute("automation", "run-one");
    expect(controller.snapshot()).toMatchObject({ selectedNodeId: "first",
      stepEvidence: { runId: "run-one", nodeId: "first" } });
    expect(client.getAutomationStepEvidence).toHaveBeenCalledExactlyOnceWith(
      "run-one", "first", "dev", false,
    );
    const html = renderAutomationRun(controller.snapshot());
    expect(html).toMatch(/data-automation-node="first" data-state="succeeded" aria-pressed="true"/);
    expect(html).toContain("run-one/first saved output");
    expect(html).not.toContain("Choose a step to explore its saved result.");
  });

  test("refresh retains a manual step and switching runs restores the first step", async () => {
    const { client, controller } = fixture();
    await controller.openRoute("automation", "run-one");
    controller.selectNode("second");
    await vi.waitFor(() => expect(controller.snapshot().stepEvidence?.nodeId).toBe("second"));
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ selectedNodeId: "second",
      stepEvidence: { runId: "run-one", nodeId: "second" } });
    await controller.openRoute("automation", "run-two");
    expect(controller.snapshot()).toMatchObject({ selectedNodeId: "first",
      stepEvidence: { runId: "run-two", nodeId: "first" } });
    expect(client.getAutomationStepEvidence).toHaveBeenLastCalledWith("run-two", "first", "dev", false);
    await controller.openRun("run-three");
    await vi.waitFor(() => expect(controller.snapshot().stepEvidence?.runId).toBe("run-three"));
    expect(controller.snapshot()).toMatchObject({ selectedNodeId: "first",
      stepEvidence: { runId: "run-three", nodeId: "first" } });
  });

  test("manual selection supersedes a pending initial evidence read", async () => {
    const { client, controller } = fixture();
    let resolve!: (value: { evidence: ReturnType<typeof evidence> }) => void;
    const initialEvidence = new Promise<{ evidence: ReturnType<typeof evidence> }>((done) => { resolve = done; });
    client.getAutomationStepEvidence.mockImplementationOnce(() => initialEvidence);
    const opening = controller.openRoute("automation", "run-one");
    await vi.waitFor(() => expect(controller.snapshot().selectedNodeId).toBe("first"));
    controller.selectNode("second");
    await vi.waitFor(() => expect(controller.snapshot().stepEvidence?.nodeId).toBe("second"));
    resolve({ evidence: evidence("run-one", "first") });
    await opening;
    expect(controller.snapshot()).toMatchObject({ selectedNodeId: "second",
      stepEvidence: { runId: "run-one", nodeId: "second" } });
  });

  test.each([null, { title: "Empty report", body: { kind: "sequence", id: "root", children: [] } }])(
    "does not select or request evidence when the frozen run has no displayable step", async (frozen) => {
      const { client, controller } = fixture(frozen);
      await controller.openRoute("automation", "run-one");
      expect(controller.snapshot().selectedNodeId).toBe("");
      expect(client.getAutomationStepEvidence).not.toHaveBeenCalled();
    },
  );

  test("opening the editor leaves step selection to the user", async () => {
    const { client, controller } = fixture();
    await controller.openRoute("automation");
    expect(controller.snapshot().selectedNodeId).toBe("");
    expect(client.getAutomationStepEvidence).not.toHaveBeenCalled();
  });
});
