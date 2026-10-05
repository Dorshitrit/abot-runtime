import { describe, expect, it, vi } from "vitest";
import type { AutomationRevision, SequenceNode, ToolNode } from "../automations/definition-contracts.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import type { AutomationResultStore } from "../automations/result-store.js";
import { readAutomationRunOutputSummary } from "../automations/run-output-summary.js";
import { createAutomationService } from "../automations/service.js";
import { emptyAutomationJournalState, type AutomationResultRecord } from "../automations/storage-records.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type { SchedulerAutomationRun, SchedulerService } from "../scheduler/contracts.js";

function tool(id: string): ToolNode {
  return { kind: "tool", id, title: `Title ${id}`, onFailure: "stop", controls: {},
    operation: { toolName: "fixture", operationId: "read", contractVersion: 1 } };
}

function sequence(id: string, children: SequenceNode["children"]): SequenceNode {
  return { kind: "sequence", id, children };
}

function fixture(children: SequenceNode["children"] = [tool("first"), tool("last")]) {
  const definition: AutomationRevision = {
    schemaVersion: 1, automationId: "automation", revision: 2, title: "Summary",
    objective: "Return the outcome", trigger: { kind: "manual" }, inputs: {},
    body: sequence("root", children), limits: DEFAULT_AUTOMATION_LIMITS,
  };
  const graph = compileAutomationGraph(definition);
  if (!graph.ok) throw new Error(JSON.stringify(graph.issues));
  const run: SchedulerAutomationRun = {
    id: "run", jobId: "job", environmentId: "dev", title: "Summary", timeZone: "UTC",
    jobRevision: 1, target: { kind: "automation", automationId: "automation", definitionRevision: 2 },
    status: "succeeded", trigger: "manual", scheduledAt: "2026-09-30T10:00:00Z",
  };
  const state = emptyAutomationJournalState();
  state.definitions.push({ id: "definition", automationId: "automation", revision: 2,
    definition, publishedAt: "2026-09-30T09:00:00Z" });
  state.executions.push({ id: run.id, automationId: "automation", definitionRevision: 2,
    revision: 1, inputIds: [], nodes: graph.graph.steps.map(({ id }) => ({
      nodeId: id, status: "succeeded", resultRef: `result-${id}`,
    })) });
  state.results.push(...graph.graph.steps.map(({ id }): AutomationResultRecord => ({
    id: `result-${id}`, runId: run.id, nodeId: id, kind: "node_output", storageRef: id,
    digest: "digest", sizeBytes: 1, createdAt: "2026-09-30T10:00:00Z",
  })));
  const saved = new Map<string, unknown>(graph.graph.steps.map(({ id }) => [
    `result-${id}`, { text: `Output ${id}` },
  ]));
  const results = {
    read: vi.fn(async (record: AutomationResultRecord) => saved.get(record.id)),
    save: async () => { throw new Error("unexpected_result_write"); },
    discardUncommitted: async () => { throw new Error("unexpected_result_delete"); },
    releasePublication: async () => { throw new Error("unexpected_result_release"); },
    reconcileUncommitted: async () => { throw new Error("unexpected_result_cleanup"); },
  } satisfies AutomationResultStore;
  const persistence = {
    read: vi.fn(async () => structuredClone(state)),
    update: async () => { throw new Error("unexpected_state_write"); },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_write"); },
  } satisfies AutomationPersistence;
  const read = () => readAutomationRunOutputSummary({ state, runId: run.id,
    definition, results, persistence });
  function serviceRun() {
    const scheduler = { getAutomationRun: async () => ({ ...run, reportRef: "derived:run" }),
      listAutomationRuns: async () => [], stopAutomationRun: async () => undefined };
    return createAutomationService({ config: { runtimeId: "dev" } as RuntimeConfig,
      scheduler: scheduler as unknown as SchedulerService,
      persistence, results, tools: {} as ToolRegistry }).getRun(run.id);
  }
  return { state, saved, results, persistence, read, serviceRun };
}

describe("automation run terminal output summary", () => {
  it("reads only the final sequential output with canonical text/data previews", async () => {
    const f = fixture();
    const text = "a".repeat(4_100);
    const data = { decision: "No change", explanation: "No current records to act on" };
    f.saved.set("result-last", { text, data });
    const summary = await f.read();
    expect(summary.omitted).toBe(0);
    expect(summary.entries).toEqual([{
      nodeId: "last", title: "Title last", stepStatus: "succeeded", availability: "available",
      output: { full: false, text: { value: text.slice(0, 4_000), truncated: true, totalCharacters: 4_100 },
        data: { value: JSON.stringify(data, null, 2), truncated: false,
          totalCharacters: JSON.stringify(data, null, 2).length } },
    }]);
    expect(f.results.read.mock.calls.map(([record]) => record.id)).toEqual(["result-last"]);
    expect(f.persistence.read).not.toHaveBeenCalled();
  });

  it("preserves nested parallel tails without intermediate branch output", async () => {
    const f = fixture([{ kind: "parallel", id: "parallel", branches: [
      sequence("left", [tool("left-first"), { kind: "parallel", id: "nested", branches: [
        sequence("nested-a", [tool("tail-a")]), sequence("nested-b", [tool("tail-b")]),
      ] }]), sequence("right", [tool("right-first"), tool("tail-c")]),
    ] }]);
    expect((await f.read()).entries.map((entry) => entry.nodeId)).toEqual(["tail-a", "tail-b", "tail-c"]);
    expect(f.results.read).toHaveBeenCalledTimes(3);
  });

  it("reports only a post-join terminal step when branches feed a final consumer", async () => {
    const f = fixture([{ kind: "parallel", id: "parallel", branches: [
      sequence("left", [tool("a")]), sequence("right", [tool("b")]),
    ] }, tool("joined")]);
    expect((await f.read()).entries.map((entry) => entry.nodeId)).toEqual(["joined"]);
    expect(f.results.read).toHaveBeenCalledTimes(1);
  });

  it("bounds displayed terminal outputs and disk reads to four with an explicit omitted count", async () => {
    const f = fixture([{ kind: "parallel", id: "parallel", branches: Array.from({ length: 6 }, (_, index) =>
      sequence(`branch-${index}`, [tool(`tail-${index}`)])) }]);
    const summary = await f.read();
    expect(summary.entries.map((entry) => entry.nodeId)).toEqual(["tail-0", "tail-1", "tail-2", "tail-3"]);
    expect(summary.omitted).toBe(2);
    expect(f.results.read).toHaveBeenCalledTimes(4);
  });

  it.each(["failed", "skipped", "cancelled", "interrupted"] as const)(
    "preserves %s status and its error without replacing it with the saved text", async (status) => {
      const f = fixture();
      f.state.executions[0] = { ...f.state.executions[0]!, nodes: [{ nodeId: "last", status,
        resultRef: "result-last", errorCode: "fixture_step_failed" }] };
      expect((await f.read()).entries[0]).toMatchObject({ stepStatus: status,
        errorCode: "fixture_step_failed", availability: "available", output: { text: { value: "Output last" } } });
    },
  );

  it("retains pending terminal entries without borrowing an earlier successful output", async () => {
    const f = fixture();
    f.state.executions[0] = { ...f.state.executions[0]!, nodes: [f.state.executions[0]!.nodes[0]!] };
    expect((await f.read()).entries[0]).toMatchObject({ nodeId: "last", stepStatus: "pending",
      availability: "unavailable", output: null });
    expect(f.results.read).not.toHaveBeenCalled();
  });

  it.each([
    { runId: "different-run" }, { nodeId: "different-node" },
    { kind: "report" as const }, { id: "different-result" },
  ])("rejects unrelated saved output ownership %j before reading bytes", async (override) => {
    const f = fixture();
    f.state.results[1] = { ...f.state.results[1]!, ...override };
    expect((await f.read()).entries[0]).toMatchObject({ availability: "unavailable", output: null });
    expect(f.results.read).not.toHaveBeenCalled();
  });

  it.each([{ id: "different-run" }, { automationId: "different-automation" }, { definitionRevision: 1 }])(
    "rejects an unrelated execution %j before following its result reference", async (override) => {
      const f = fixture();
      f.state.executions[0] = { ...f.state.executions[0]!, ...override };
      expect((await f.read()).entries[0]).toMatchObject({ stepStatus: "pending", availability: "unavailable", output: null });
      expect(f.results.read).not.toHaveBeenCalled();
    },
  );

  it("preserves expired output entries without attempting to read removed bytes", async () => {
    const f = fixture();
    f.state.executions[0] = { ...f.state.executions[0]!, detailsExpiredAt: "2026-10-30T10:00:00Z" };
    f.state.results = [];
    expect((await f.read()).entries[0]).toMatchObject({ stepStatus: "succeeded", availability: "expired", output: null });
    expect(f.results.read).not.toHaveBeenCalled();
  });

  it("recognizes an expiry race with one bounded metadata read and no result retry", async () => {
    const f = fixture([{ kind: "parallel", id: "parallel", branches: [
      sequence("left", [tool("a")]), sequence("right", [tool("b")]),
    ] }]);
    f.results.read.mockImplementation(async () => { throw new Error("ENOENT"); });
    f.persistence.read.mockImplementation(async () => {
      const latest = structuredClone(f.state);
      latest.executions[0] = { ...latest.executions[0]!, detailsExpiredAt: "2026-10-30T10:00:00Z" };
      return latest;
    });
    expect((await f.read()).entries.map((entry) => entry.availability)).toEqual(["expired", "expired"]);
    expect(f.results.read).toHaveBeenCalledTimes(2);
    expect(f.persistence.read).toHaveBeenCalledTimes(1);
  });

  it.each([[null], [{ text: 42 }], [[]]])("keeps malformed output %j unavailable", async (value) => {
    const f = fixture();
    f.saved.set("result-last", value);
    expect((await f.read()).entries[0]).toMatchObject({ availability: "unavailable", output: null });
  });

  it("does not turn a rejected receipt into invented output", async () => {
    const f = fixture();
    f.saved.set("result-last", { kind: "rejected", code: "fixture_rejected" });
    expect((await f.read()).entries[0]).toMatchObject({ availability: "available", output: null });
  });

  it("keeps the compact service report readable when output bytes and expiry lookup fail", async () => {
    const f = fixture();
    f.results.read.mockRejectedValue(new Error("automation_result_corrupt"));
    f.persistence.read.mockResolvedValueOnce(structuredClone(f.state))
      .mockRejectedValue(new Error("journal_temporarily_unavailable"));
    const run = await f.serviceRun();
    expect(run.report).toMatchObject({ outcome: "succeeded", nodeResults: [
      { nodeId: "first", status: "succeeded" }, { nodeId: "last", status: "succeeded" },
    ] });
    expect(run.outputSummary.entries[0]).toMatchObject({ availability: "unavailable", output: null });
  });
});
