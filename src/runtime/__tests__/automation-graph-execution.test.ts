import { describe, expect, it } from "vitest";
import type { AutomationRevision, SequenceNode, ToolNode } from "../automations/definition-contracts.js";
import { executeAutomationGraph } from "../automations/graph-executor.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import { createAutomationNodeTransactions } from "../automations/node-transactions.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";

function persistence(): AutomationPersistence {
  let state = emptyAutomationJournalState();
  return {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const copy = structuredClone(state);
      const result = mutate(copy);
      state = copy;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
}

function tool(id: string, onFailure: "stop" | "skip" = "stop"): ToolNode {
  return {
    kind: "tool", id, title: id, onFailure,
    operation: { toolName: "fixture", operationId: "read", contractVersion: 1 },
    controls: {},
  };
}

function sequence(id: string, children: SequenceNode["children"]): SequenceNode {
  return { kind: "sequence", id, children };
}

function revision(body: SequenceNode): AutomationRevision {
  return {
    schemaVersion: 1, automationId: "automation", revision: 3,
    title: "Test", objective: "Test exact order", trigger: { kind: "manual" },
    inputs: {}, body, limits: DEFAULT_AUTOMATION_LIMITS,
  };
}

function graph(definition: AutomationRevision) {
  const result = compileAutomationGraph(definition);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.graph;
}

describe("automation graph execution", () => {
  it("joins parallel branches after both settle, independent of completion order", async () => {
    const definition = revision(sequence("root", [
      { kind: "parallel", id: "fork", branches: [
        sequence("left", [tool("left-tool")]),
        sequence("right", [tool("right-tool")]),
      ] },
      tool("after-join"),
    ]));
    const transactions = createAutomationNodeTransactions({ persistence: persistence() });
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const running = executeAutomationGraph({
      runId: "run1", automationId: "automation", definition, inputIds: [],
      graph: graph(definition), transactions,
      executeStep: async (step) => {
        started.push(step.id);
        if (step.id !== "after-join") {
          await new Promise<void>((resolve) => releases.set(step.id, resolve));
        }
        await transactions.settleNode({ runId: "run1", nodeId: step.id, status: "succeeded",
          result: { id: `result-${step.id}`, runId: "run1", nodeId: step.id,
            kind: "node_output", storageRef: `automation-results/${step.id}.json`,
            digest: "digest", sizeBytes: 1, createdAt: new Date(0).toISOString() } });
        return { status: "succeeded" };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["left-tool", "right-tool"]);
    releases.get("right-tool")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).not.toContain("after-join");
    releases.get("left-tool")!();
    expect((await running).status).toBe("succeeded");
    expect(started).toEqual(["left-tool", "right-tool", "after-join"]);
  });

  it("continues after an explicitly skippable failed step", async () => {
    const definition = revision(sequence("root", [tool("optional", "skip"), tool("next")]));
    const transactions = createAutomationNodeTransactions({ persistence: persistence() });
    const calls: string[] = [];
    const result = await executeAutomationGraph({
      runId: "run2", automationId: "automation", definition, inputIds: [],
      graph: graph(definition), transactions,
      executeStep: async (step) => {
        calls.push(step.id);
        if (step.id === "optional") return { status: "failed", errorCode: "test_failure" };
        await transactions.settleNode({ runId: "run2", nodeId: step.id, status: "succeeded",
          result: { id: "result-next", runId: "run2", nodeId: step.id,
            kind: "node_output", storageRef: "automation-results/next.json",
            digest: "digest", sizeBytes: 1, createdAt: new Date(0).toISOString() } });
        return { status: "succeeded" };
      },
    });
    expect(calls).toEqual(["optional", "next"]);
    expect(result.status).toBe("completed_with_skips");
    expect((await transactions.get("run2"))?.nodes.map(({ status }) => status))
      .toEqual(["skipped", "succeeded"]);
  });

  it("does not dispatch a following node after durable Stop intent", async () => {
    const definition = revision(sequence("root", [tool("active"), tool("later")]));
    const transactions = createAutomationNodeTransactions({ persistence: persistence() });
    const calls: string[] = [];
    let finishActive: (() => void) | undefined;
    const running = executeAutomationGraph({
      runId: "run3", automationId: "automation", definition, inputIds: [],
      graph: graph(definition), transactions,
      executeStep: async (step) => {
        calls.push(step.id);
        if (step.id === "active") await new Promise<void>((resolve) => { finishActive = resolve; });
        await transactions.settleNode({ runId: "run3", nodeId: step.id, status: "succeeded",
          result: { id: `result-${step.id}`, runId: "run3", nodeId: step.id,
            kind: "node_output", storageRef: `automation-results/${step.id}.json`,
            digest: "digest", sizeBytes: 1, createdAt: new Date(0).toISOString() } });
        return { status: "succeeded" };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await transactions.requestStop("run3");
    finishActive!();
    expect((await running).status).toBe("cancelled");
    expect(calls).toEqual(["active"]);
    expect((await transactions.get("run3"))?.nodes.map(({ status }) => status))
      .toEqual(["succeeded", "cancelled"]);
  });

  it("drains a started sibling after another branch fails durably", async () => {
    const definition = revision(sequence("root", [
      { kind: "parallel", id: "fork", branches: [
        sequence("left", [tool("bad")]),
        sequence("right", [tool("held")]),
      ] },
      tool("after-join"),
    ]));
    const transactions = createAutomationNodeTransactions({ persistence: persistence() });
    const started: string[] = [];
    let releaseHeld!: () => void;
    let heldSignal: AbortSignal | undefined;
    const running = executeAutomationGraph({
      runId: "run4", automationId: "automation", definition, inputIds: [],
      graph: graph(definition), transactions,
      executeStep: async (step, signal) => {
        started.push(step.id);
        if (step.id === "bad") {
          await transactions.settleNode({
            runId: "run4", nodeId: step.id, status: "failed", errorCode: "failure",
          });
          return { status: "succeeded" }; // Deliberate receipt mismatch rejects this branch.
        }
        heldSignal = signal;
        await new Promise<void>((resolve) => { releaseHeld = resolve; });
        return { status: "cancelled" };
      },
    });
    let graphSettled = false;
    void running.then(() => { graphSettled = true; }, () => { graphSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["bad", "held"]);
    expect(heldSignal?.aborted).toBe(true);
    expect(graphSettled).toBe(false);
    releaseHeld();
    await expect(running).rejects.toThrow("automation_node_settlement_mismatch");
    expect(started).not.toContain("after-join");
  });

  it("holds a stopped parallel run until both started branches settle", async () => {
    const definition = revision(sequence("root", [
      { kind: "parallel", id: "fork", branches: [
        sequence("left-branch", [tool("left")]),
        sequence("right-branch", [tool("right")]),
      ] },
      tool("after-join"),
    ]));
    const transactions = createAutomationNodeTransactions({ persistence: persistence() });
    const abort = new AbortController();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const running = executeAutomationGraph({
      runId: "run5", automationId: "automation", definition, inputIds: [],
      graph: graph(definition), transactions, abortSignal: abort.signal,
      executeStep: async (step) => {
        started.push(step.id);
        await new Promise<void>((resolve) => releases.set(step.id, resolve));
        return { status: "cancelled" };
      },
    });
    let graphSettled = false;
    void running.then(() => { graphSettled = true; }, () => { graphSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["left", "right"]);
    await transactions.requestStop("run5");
    abort.abort();
    releases.get("left")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(graphSettled).toBe(false);
    expect(started).not.toContain("after-join");
    releases.get("right")!();
    expect((await running).status).toBe("cancelled");
  });
});
